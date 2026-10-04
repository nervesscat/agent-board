# PR <number>: <title>

<repo name> · <head branch> into <base branch> · <short sha> · <author>

## What it does

<One paragraph, at most 70 words, in plain words: the problem and what the change does about it. No code, no file names, no list of every touched function. A reader decides in ten seconds whether this PR concerns them.>

## How to test it

<At most five numbered steps, one line each, that a teammate can follow on their machine: branch, how to start it, what to call or click, what they should see. Use the commands the review actually ran. If something could not be run here, one line saying what and why, no more.>

## Findings

- **<claim, one sentence>** (<blocker|bug>, <confirmed|plausible>). <Why it matters, one sentence.> Fix: <a few words>. `<path:line>`

<Each bullet at most 50 words. If there are none, a single line: "No findings. <n> checklist items passed with citations, <m> candidates refuted, <k> of <t> criteria executed.">

<Optionally, one more line of at most 30 words starting with "Before merging:" for an operational step the author or an operator must take (run a migration, set a variable, rotate a key). Only when the review established it, never as advice.>

## Evidence

![<what the picture shows>](shots/<file>.png)

<Only screenshots the review took. Omit the section when there are none.>

## Checks

| Check | Answer | Why |
|---|---|---|
| Is this reliable? | YES or NO | <at most 20 words> |
| Did you make sure this works and is running? | YES or NO | <at most 20 words> |
| Will this have any issue with the latest version of the base branch? | YES or NO | <at most 20 words> |

The whole file fits on one printed page. Everything else belongs in `review.md`.
