import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { and, desc, eq, isNull } from 'drizzle-orm'

import { db, schema } from '#/db'
import { DAY_MS } from '#/lib/alerts'
import { AGENT_CLIENTS, type AgentClient } from '#/lib/constants'
import { AGENTS, repoClaudeDir, reviewSkillsInstall, sessionSkillInstall, skillInstall } from '#/lib/agents'
import type { UpdatesState } from '#/lib/updates'
import * as agents from '../agents'
import type { SkillTransport } from '../agents'
import { config } from '../config'
import { checkHostTools, hostTools, type HostTool, type HostTools, type ToolName } from '../hostTools'
import { listStages, type Stage } from '../stages'
import { listAgentTokens } from '../tokens'
import { checkForUpdates, insideDesktopApp, installUpdate, updatesState } from '../updates'
import type { AlertCandidate, AlertType } from './registry'

/**
 * The alerts about the board's own setup and versions (group `setup`): the skills it serves against the
 * copies installed on this machine, a newer release of the app, tickets waiting in the Release stage, the
 * agent tokens that run out, an update stuck in the desktop app, repos without the skills and the tools
 * the board runs. Each type is made by a function that takes the board's edges (the home folder, the
 * desktop app's updater, the host-tools check), so a test hands it fakes at the edges and nothing else.
 */

/** What a type reaches outside the database and the files it reads: swapped in tests. */
export interface SetupEdges {
  /** The home the board runs as: where the board and session skills are installed. */
  home: () => string
  /** The desktop app's updater (`updates.ts`). */
  updates: {
    inside: () => boolean
    state: () => Promise<UpdatesState>
    check: () => Promise<UpdatesState>
    install: () => Promise<UpdatesState>
  }
  /** The check of the tools on this machine (`hostTools.ts`). */
  tools: { last: () => HostTools | null; check: () => Promise<HostTools> }
}

export const realEdges: SetupEdges = {
  home: () => os.homedir(),
  updates: { inside: insideDesktopApp, state: updatesState, check: checkForUpdates, install: installUpdate },
  tools: { last: hostTools, check: checkHostTools },
}

const SETTINGS = '/settings#updates'
const AGENTS_PAGE = '/agents'
const dayOf = (iso: string) => iso.slice(0, 10)
const lines = (items: string[], most = 8) =>
  items.length > most ? [...items.slice(0, most), `and ${items.length - most} more`] : items

// --- 1: skills outdated ---

const CLIENT_LABEL: Record<AgentClient, string> = {
  claude: AGENTS.claude.label,
  codex: AGENTS.codex.label,
  opencode: AGENTS.opencode.label,
}

/** A SKILL.md as installed on this machine, when there is one: its client and what it is. */
interface InstalledSkill {
  what: string
  file: string
  /** What the update writes in its place. */
  write: () => Promise<unknown>
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

const lf = (text: string) => text.replace(/\r\n/g, '\n')

const MARKER = 'http://board-address.invalid'
// An origin without the punctuation that may follow it in a sentence.
const ORIGIN = /^https?:\/\/[^\s"'`)<>/]+?(?=[.,;:]?(?:[\s"'`)<>/]|$))/

/**
 * The board address `installed` records when it is the skill the board serves for `transport` in all
 * but that address (every place the address stands holds the same one), else null.
 */
function recordedUrl(client: AgentClient, transport: SkillTransport, installed: string): string | null {
  const text = lf(installed)
  const before = lf(agents.renderSkill(client, transport, MARKER)).split(MARKER)[0]!
  if (!text.startsWith(before)) return null
  const url = ORIGIN.exec(text.slice(before.length))?.[0]
  if (!url) return null
  return lf(agents.renderSkill(client, transport, url)) === text ? url : null
}

/** An address in a skill that no longer matches what is served: the first board-looking one, to keep. */
const looseAddress = (installed: string): string | null =>
  /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/.exec(installed)?.[0] ?? null

/**
 * The board and session skills installed under `home` that differ from what the board serves now. A
 * skill that is not installed is not outdated (idea 18 says when none is). A copy of the board skill
 * is current when it equals the MCP or the REST variant, fetched through any of the board's addresses.
 */
export async function outdatedAgentSkills(home: string): Promise<InstalledSkill[]> {
  const out: InstalledSkill[] = []
  for (const client of AGENT_CLIENTS) {
    const label = CLIENT_LABEL[client]
    const board = await readText(path.join(agents.skillDir(client, home), 'SKILL.md'))
    if (board !== null) {
      // A copy is current when it equals what the board serves, whatever address it records: a preview
      // board on this machine shares the home with the live one and serves it at another port.
      const current = agents.SKILL_TRANSPORTS.some((t) => recordedUrl(client, t, board) !== null)
      if (!current) {
        // A copy for a session without the MCP tools stays one.
        const transport = board.includes('REST API, no MCP tools)') ? 'rest' : 'mcp'
        out.push({
          what: `Board skill for ${label}`,
          file: path.join(agents.skillDir(client, home), 'SKILL.md'),
          // The address already in the file stays: only what really differs is rewritten.
          write: () => agents.installSkill(client, home, transport, looseAddress(board) ?? config.boardUrl),
        })
      }
    }
    const session = await readText(agents.sessionSkillFile(client, home))
    if (session !== null && lf(session) !== lf(agents.sessionSkill()))
      out.push({
        what: `Session skill for ${label}`,
        file: agents.sessionSkillFile(client, home),
        write: () => agents.installSessionSkill(client, home),
      })
  }
  return out
}

const reviewFilesChanged = (files: { path: string; status: string }[]) =>
  files.filter((f) => f.status !== 'current').map((f) => `${f.path} (${f.status})`)

function skillsOutdatedType(edges: SetupEdges): AlertType {
  return {
    type: 'skills-outdated',
    idea: 1,
    group: 'setup',
    label: 'Skills were updated',
    description:
      'The board, session or review skills installed on this machine differ from what the board serves',
    scope: 'board',
    async check() {
      const agentSkills = await outdatedAgentSkills(edges.home())
      const review = (await agents.reviewSkillsStatus()).global
      const reviewOutdated = review.status === 'outdated'
      if (!agentSkills.length && !reviewOutdated) return []
      const details = [
        ...agentSkills.map((s) => `${s.what}: ${s.file}`),
        ...(reviewOutdated ? reviewFilesChanged(review.files).map((f) => `Review skills: ${f}`) : []),
      ]
      return [
        {
          severity: 'warning',
          title: 'Skills were updated',
          body: 'The skills installed on this machine are not the ones this board serves now. Agents follow the installed copy until it is updated.',
          details: lines(details, 12),
          buttons: [
            { id: 'update', label: 'Update', kind: 'action', primary: true },
            { id: 'open', label: 'Open', kind: 'link', href: `${AGENTS_PAGE}#review-skills` },
          ],
        },
      ]
    },
    actions: {
      /** What the Install skill buttons do (api.ts), for the copies that are outdated. */
      async update() {
        const written: string[] = []
        for (const s of await outdatedAgentSkills(edges.home())) {
          await s.write()
          written.push(s.what)
        }
        if ((await agents.reviewSkillsStatus()).global.status === 'outdated') {
          await agents.installReviewSkills()
          written.push('Review skills')
        }
        return {
          message: written.length ? `Updated: ${written.join(', ')}` : 'Already up to date',
          resolve: true,
        }
      },
    },
  }
}

function repoSkillsOutdatedType(): AlertType {
  return {
    type: 'repo-skills-outdated',
    idea: 1,
    group: 'setup',
    label: 'Repo skills were updated',
    description: "The review skills in a repo's own .claude folder differ from what the board serves",
    scope: 'project',
    async check(ctx) {
      if (ctx.projectId === null) return []
      const { repos } = await agents.reviewSkillsStatus(ctx.projectId)
      const found: AlertCandidate[] = []
      for (const repo of repos) {
        if (repo.status !== 'outdated') continue
        found.push({
          subject: String(repo.repoId),
          severity: 'warning',
          title: `Review skills in ${repo.repoName} were updated`,
          body: `The copy in ${repo.repoPath}/.claude differs from the one this board serves. Agents working in the repo follow it.`,
          details: lines(reviewFilesChanged(repo.files)),
          buttons: [
            {
              id: 'copy',
              label: 'Copy update command',
              kind: 'copy',
              text: reviewSkillsInstall('bash', config.boardUrl, '', repoClaudeDir(repo.repoPath)),
            },
            { id: 'open', label: 'Open', kind: 'link', href: `${AGENTS_PAGE}#review-skills` },
          ],
        })
      }
      return found
    },
  }
}

// --- 2: a board update is available ---

function boardUpdateType(edges: SetupEdges): AlertType {
  return {
    type: 'board-update-available',
    idea: 2,
    group: 'setup',
    label: 'Board update available',
    description: 'The desktop app is offered a newer release',
    scope: 'board',
    applies: edges.updates.inside,
    /**
     * Raised for every offered release, whether or not this browser's update card skipped it (that memory
     * lives in the browser: `lib/updateCard.ts`): the alert is the place a skipped release stays findable.
     * The human's dismissal is of this release alone; the next one is a new alert.
     */
    async check() {
      const state = await edges.updates.state()
      if (state.mode !== 'desktop' || state.status !== 'available' || !state.newest) return []
      return [
        {
          subject: state.newest.version,
          severity: 'info',
          title: `CrossBoard ${state.newest.version} is available`,
          body: `This board runs ${state.installed}.${state.newest.date ? ` Released ${dayOf(state.newest.date)}.` : ''}`,
          buttons: [
            { id: 'install', label: 'Download and install', kind: 'action', primary: true },
            { id: 'open', label: 'Open', kind: 'link', href: SETTINGS },
          ],
        },
      ]
    },
    actions: {
      async install() {
        await edges.updates.install()
        return { message: 'Downloading the update' }
      },
    },
  }
}

// --- 3: release due ---

/** Tickets in the Release stage for this long make a release due. */
export const RELEASE_DUE_DAYS = 3
/** This many tickets in the Release stage make a release due. */
export const RELEASE_DUE_TICKETS = 5

/** The stage tickets wait in until they are released: a done stage with the key or the name "release". */
export const releaseStageOf = (stages: Stage[]) =>
  stages.find(
    (s) =>
      s.kind === 'done' && (s.key.toLowerCase() === 'release' || s.name.trim().toLowerCase() === 'release'),
  )

const releaseType: AlertType = {
  type: 'release-due',
  idea: 3,
  group: 'setup',
  label: 'Release due',
  description: `${RELEASE_DUE_TICKETS} tickets, or one for ${RELEASE_DUE_DAYS} days, are waiting in the Release stage`,
  scope: 'project',
  check(ctx) {
    if (ctx.projectId === null) return []
    const stage = releaseStageOf(listStages(ctx.projectId))
    if (!stage) return []
    const waiting = db
      .select()
      .from(schema.tickets)
      .where(
        and(
          eq(schema.tickets.projectId, ctx.projectId),
          eq(schema.tickets.status, stage.key),
          isNull(schema.tickets.archivedAt),
          isNull(schema.tickets.prId),
        ),
      )
      .all()
      .map((t) => {
        // Since it moved there; a ticket with no such move on record since it was created.
        const moved = db
          .select({ at: schema.ticketEvents.at })
          .from(schema.ticketEvents)
          .where(
            and(
              eq(schema.ticketEvents.ticketId, t.id),
              eq(schema.ticketEvents.kind, 'stage'),
              eq(schema.ticketEvents.toStage, stage.key),
            ),
          )
          .orderBy(desc(schema.ticketEvents.at))
          .get()
        const since = Date.parse(moved?.at ?? t.updatedAt)
        return { id: t.id, title: t.title, days: Math.max(0, Math.floor((ctx.now() - since) / DAY_MS)) }
      })
      .sort((a, b) => b.days - a.days || a.id - b.id)
    if (!waiting.length) return []
    const oldest = waiting[0]!.days
    if (waiting.length < RELEASE_DUE_TICKETS && oldest < RELEASE_DUE_DAYS) return []
    const n = waiting.length
    return [
      {
        severity: 'info',
        title: 'Time to cut a release',
        body: `${n} ticket${n === 1 ? ' is' : 's are'} waiting in ${stage.name}, the oldest for ${oldest} day${oldest === 1 ? '' : 's'}.`,
        details: lines(
          waiting.map((t) => `#${t.id} ${t.title} (${t.days} d)`),
          10,
        ),
        buttons: [
          {
            id: 'open',
            label: 'Open the tickets',
            kind: 'link',
            href: `/projects/${ctx.projectId}/features`,
          },
        ],
      },
    ]
  },
}

// --- 16: an agent token about to expire ---

/** A token with this many days left or fewer is about to expire. */
export const TOKEN_WARN_DAYS = 14

const tokenType: AlertType = {
  type: 'agent-token-expiring',
  idea: 16,
  group: 'setup',
  label: 'Agent token about to expire',
  description: `An agent token has ${TOKEN_WARN_DAYS} days or fewer left, or has expired`,
  scope: 'board',
  snoozeOptions: [7 * DAY_MS],
  check(ctx) {
    // Per agent name, the token that lasts longest: an older one left behind does not count once a new one was made.
    const latest = new Map<string, ReturnType<typeof listAgentTokens>[number]>()
    for (const t of listAgentTokens()) {
      const known = latest.get(t.name)
      if (!known || Date.parse(t.expiresAt) > Date.parse(known.expiresAt)) latest.set(t.name, t)
    }
    const found: AlertCandidate[] = []
    for (const t of latest.values()) {
      const left = Date.parse(t.expiresAt) - ctx.now()
      if (left > TOKEN_WARN_DAYS * DAY_MS) continue
      const expired = left <= 0
      const days = Math.ceil(left / DAY_MS)
      found.push({
        subject: String(t.id),
        severity: expired ? 'problem' : 'warning',
        title: expired
          ? `The token for ${t.name} has expired`
          : `The token for ${t.name} expires in ${days} day${days === 1 ? '' : 's'}`,
        body: `The token for ${t.name} ${expired ? 'expired' : 'expires'} on ${dayOf(t.expiresAt)}. ${
          expired ? 'It no longer signs in' : 'After that it stops signing in'
        } and its agent fails with an authentication error.`,
        buttons: [
          { id: 'generate', label: 'Generate new commands', kind: 'link', href: AGENTS_PAGE },
          { id: 'tokens', label: 'Open', kind: 'link', href: `${AGENTS_PAGE}#agent-tokens` },
        ],
      })
    }
    return found
  },
}

// --- 17: an update stuck in the desktop app ---

function stuckUpdateType(edges: SetupEdges): AlertType {
  return {
    type: 'desktop-update-stuck',
    idea: 17,
    group: 'setup',
    label: 'Update needs a manual step',
    description: 'The desktop app downloaded an update it could not install, or its last update check failed',
    scope: 'board',
    applies: edges.updates.inside,
    async check() {
      const state = await edges.updates.state()
      if (state.mode !== 'desktop') return []
      if (state.status === 'manual' && state.manual) {
        const version = state.newest?.version
        return [
          {
            subject: 'manual',
            severity: 'warning',
            title: `${version ? `Version ${version}` : 'The update'} is downloaded but could not install itself`,
            body: 'Run this command to install it.',
            details: [state.manual.command],
            buttons: [
              { id: 'copy', label: 'Copy command', kind: 'copy', text: state.manual.command },
              { id: 'open', label: 'Open', kind: 'link', href: SETTINGS },
            ],
          },
        ]
      }
      if (state.status === 'error')
        return [
          {
            subject: 'error',
            severity: 'warning',
            title: 'The last update check failed',
            body: state.error ?? 'The updater gave no reason.',
            buttons: [
              { id: 'retry', label: 'Try again', kind: 'action', primary: true },
              { id: 'open', label: 'Open', kind: 'link', href: SETTINGS },
            ],
          },
        ]
      return []
    },
    actions: {
      async retry() {
        await edges.updates.check()
        return { message: 'Checking for updates', resolve: true }
      },
    },
  }
}

// --- 18: a repo without the board skills ---

/** Whether a file is there. */
const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

function repoWithoutSkillsType(edges: SetupEdges): AlertType {
  return {
    type: 'repo-without-skills',
    idea: 18,
    group: 'setup',
    label: 'Repo without the board skills',
    description: 'A repo of the project has no board skill, in its own .claude folder or on this machine',
    scope: 'project',
    stickyDismiss: true,
    async check(ctx) {
      if (ctx.projectId === null) return []
      const status = await agents.reviewSkillsStatus(ctx.projectId)
      // The user-wide copies: the review bundle, and the board skill of any client.
      if (status.global.status !== 'none') return []
      const home = edges.home()
      for (const client of AGENT_CLIENTS)
        if (await exists(path.join(agents.skillDir(client, home), 'SKILL.md'))) return []
      const found: AlertCandidate[] = []
      for (const repo of status.repos) {
        if (repo.status !== 'none') continue
        if (await exists(path.join(repo.repoPath, '.claude', 'skills', 'board', 'SKILL.md'))) continue
        const install = [
          skillInstall('claude', 'bash', config.boardUrl, ''),
          sessionSkillInstall('claude', 'bash', config.boardUrl, ''),
          reviewSkillsInstall('bash', config.boardUrl, '', repoClaudeDir(repo.repoPath)),
        ].join('\n')
        found.push({
          subject: String(repo.repoId),
          severity: 'warning',
          title: `${repo.repoName} has no board skill`,
          body: `Agents working in ${repo.repoName} will not know the board's rules.`,
          buttons: [
            { id: 'copy', label: 'Copy install commands', kind: 'copy', text: install },
            { id: 'open', label: 'Open', kind: 'link', href: `${AGENTS_PAGE}#review-skills` },
          ],
        })
      }
      return found
    },
  }
}

// --- 19: a host tool is missing or broken ---

/** The oldest version of each tool the board is made for (CONTRIBUTING: Node.js 24; `packageManager`: pnpm 11). */
export const MIN_TOOL_VERSIONS: Partial<Record<ToolName, string>> = { git: '2.25', node: '24', pnpm: '11' }
const CHECKED_TOOLS: ToolName[] = ['git', 'node', 'pnpm']

/** Dotted numbers compared part by part: negative when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** What is wrong with a tool the board needs: missing, found but not runnable, or too old. Null when fine. */
export function toolFault(t: HostTool): { problem: string; fix: string } | null {
  if (!t.ok && t.problem && t.fix) return { problem: t.problem, fix: t.fix }
  if (t.version === null)
    return {
      problem: `${t.name} was found at ${t.path} but did not run: it printed no version`,
      fix: `run ${t.name} --version in a terminal to see why, then Check again`,
    }
  const min = MIN_TOOL_VERSIONS[t.name]
  if (min && compareVersions(t.version, min) < 0)
    return {
      problem: `${t.name} ${t.version} is older than the ${min} the board needs`,
      fix: `upgrade ${t.name} to ${min} or newer, then Check again (restart the board if its folder was not on its PATH yet)`,
    }
  return null
}

function hostToolType(edges: SetupEdges): AlertType {
  const faults = (result: HostTools | null) =>
    (result?.tools ?? []).flatMap((t) => {
      const fault = CHECKED_TOOLS.includes(t.name) ? toolFault(t) : null
      return fault ? [{ tool: t, ...fault }] : []
    })
  return {
    type: 'host-tool-broken',
    idea: 19,
    group: 'setup',
    label: 'A tool the board needs is missing',
    description: 'git, node or pnpm is missing, does not run or is older than the board needs',
    scope: 'board',
    check: () =>
      faults(edges.tools.last()).map(({ tool, problem, fix }) => ({
        subject: tool.name,
        // Optional tools only limit a feature; the others break previews or branch status.
        severity: tool.optional ? 'info' : 'problem',
        title: problem,
        body: `This breaks ${tool.breaks}.`,
        details: [`Fix: ${fix}`],
        buttons: [{ id: 'check-again', label: 'Check again', kind: 'action', primary: true }],
      })),
    actions: {
      async 'check-again'(ctx) {
        const result = await edges.tools.check()
        const still = faults(result).some((f) => f.tool.name === ctx.alert.subject)
        return { ok: !still, message: still ? 'Still not working' : 'Working now', resolve: !still }
      },
    },
  }
}

export function setupAlertTypes(edges: SetupEdges = realEdges): AlertType[] {
  return [
    skillsOutdatedType(edges),
    repoSkillsOutdatedType(),
    boardUpdateType(edges),
    releaseType,
    tokenType,
    stuckUpdateType(edges),
    repoWithoutSkillsType(edges),
    hostToolType(edges),
  ]
}

export const alertTypes: AlertType[] = setupAlertTypes()
