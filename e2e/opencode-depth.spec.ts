import fs from 'node:fs'
import path from 'node:path'

import type { APIRequestContext, Page } from '@playwright/test'

import { AGENTS } from '#/lib/agents'
import type { OpencodeConfig } from '#/server/opencodeConfig'
import { e2eEnv } from './env'
import { expect, ok, test } from './fixtures'

// The OpenCode card on Connect an agent warns when OpenCode's multilevel delegation is off. The board
// reads the global config under its own XDG_CONFIG_HOME (this run's folder, never the machine's), so the
// tests write the config and press Check again.

const dir = () => e2eEnv().opencodeConfigDir
const json = () => path.join(dir(), 'opencode.json')
const jsonc = () => path.join(dir(), 'opencode.jsonc')

function reset() {
  fs.rmSync(dir(), { recursive: true, force: true })
}

function write(file: string, text: string) {
  fs.mkdirSync(dir(), { recursive: true })
  fs.writeFileSync(file, text)
}

const check = (human: APIRequestContext) => ok<OpencodeConfig>(human.post('/api/agent-setup/opencode-check'))

/** The card's warning, on or off, whichever it shows. */
const card = (page: Page) => page.getByRole('region', { name: 'OpenCode multilevel delegation' })
const again = (page: Page) => page.getByRole('button', { name: 'Check the OpenCode config again' })

async function openOpencode(page: Page) {
  await page.goto('/agents?shell=bash')
  await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible()
  await page.getByRole('tab', { name: AGENTS.opencode.label }).click()
}

test.describe('the OpenCode card', () => {
  // One global config folder for the board: these tests write it in turn.
  test.describe.configure({ mode: 'serial' })

  test.afterAll(reset)

  test('with no config, warns on load with the snippet and the path it read; Check again picks up the fix', async ({
    page,
    human,
  }) => {
    reset()
    expect(await check(human)).toMatchObject({ depth: 1, set: false, source: json(), error: null })

    await openOpencode(page)
    await expect(card(page)).toContainText('Multilevel delegation is off: subagents cannot launch subagents')
    await expect(card(page)).toContainText(json())
    await expect(
      card(page).getByText('"experimental": { "subagent_depth": 2 }', { exact: true }),
    ).toBeVisible()
    await expect(card(page)).toContainText('The board only reads the file.')

    // The other clients' cards are as they were: no delegation note.
    await page.getByRole('tab', { name: AGENTS.claude.label }).click()
    await expect(card(page)).toHaveCount(0)

    // The fix written as JSONC (a comment, a trailing comma), read again from the page.
    write(
      jsonc(),
      `{
        // OpenCode allows a subagent to start a subagent above depth 1.
        "experimental": { "subagent_depth": 2, },
      }`,
    )
    await page.getByRole('tab', { name: AGENTS.opencode.label }).click()
    await again(page).click()
    await expect(card(page)).toContainText('Multilevel delegation on (depth 2)')
    await expect(card(page)).toContainText(jsonc())
    await expect(card(page)).not.toContainText('Multilevel delegation is off')

    // On load too: a reload with the config in place shows the quiet line.
    await openOpencode(page)
    await expect(card(page)).toContainText('Multilevel delegation on (depth 2)')
    expect(await check(human)).toMatchObject({ depth: 2, set: true, source: jsonc(), error: null })
  })

  test('a later config document overrides an earlier depth, as OpenCode merges them', async ({
    page,
    human,
  }) => {
    reset()
    write(json(), JSON.stringify({ experimental: { subagent_depth: 2 } }))
    // The .jsonc comes after the .json: its experimental block, even with no depth, wins.
    write(jsonc(), JSON.stringify({ experimental: { todo: true } }))
    expect(await check(human)).toMatchObject({ depth: 1, set: false, source: jsonc() })

    await openOpencode(page)
    await expect(card(page)).toContainText('Multilevel delegation is off')
    await expect(card(page)).toContainText(jsonc())
    await expect(card(page)).not.toContainText('depth 2')

    // A later lower depth over an earlier higher one: the card follows it down.
    write(jsonc(), JSON.stringify({ experimental: { subagent_depth: 1 } }))
    await again(page).click()
    await expect(card(page)).toContainText('Multilevel delegation is off')
    expect(await check(human)).toMatchObject({ depth: 1, source: jsonc() })

    // And a later higher one follows up.
    write(jsonc(), JSON.stringify({ experimental: { subagent_depth: 3 } }))
    await again(page).click()
    await expect(card(page)).toContainText('Multilevel delegation on (depth 3)')
    await expect(card(page)).toContainText(jsonc())
  })

  test('with only the deprecated top-level key, shows off and says OpenCode no longer reads it', async ({
    page,
    human,
  }) => {
    reset()
    write(json(), '{ "subagent_depth": 3 }')
    expect(await check(human)).toMatchObject({
      depth: 1,
      set: false,
      source: json(),
      ignoredDeprecated: json(),
      error: null,
    })

    await openOpencode(page)
    await expect(card(page)).toContainText('Multilevel delegation is off')
    await expect(card(page)).toContainText('is no longer read by OpenCode')
    await expect(card(page)).toContainText(json())
    await expect(card(page)).not.toContainText('Multilevel delegation on')
  })

  test('a malformed config says it could not be read, not a crash; fixing it and checking again turns it on', async ({
    page,
    human,
  }) => {
    reset()
    write(json(), '{ "experimental": ')
    const broken = await check(human)
    expect(broken).toMatchObject({ depth: 1, set: false, source: json() })
    expect(broken.error).toContain(`Could not parse ${json()}`)

    const errors: string[] = []
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
    page.on('pageerror', (e) => errors.push(e.message))

    await openOpencode(page)
    await expect(card(page)).toContainText('Could not read the OpenCode config')
    await expect(card(page)).toContainText(`Could not parse ${json()}`)
    await expect(card(page)).not.toContainText('Multilevel delegation on')

    write(json(), JSON.stringify({ experimental: { subagent_depth: 2 } }))
    await again(page).click()
    await expect(card(page)).toContainText('Multilevel delegation on (depth 2)')
    expect(errors).toEqual([])
  })
})
