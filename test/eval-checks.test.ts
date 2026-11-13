import assert from 'node:assert/strict';

import {
  answeredWithAVersion,
  didNotInventAnAnswer,
  ranNoSearches,
  type TurnResult,
} from '../eval/checks';

/**
 * A check that never fails is worse than no check at all. These tests feed the
 * no-history scenario a written answer and assert the check accepts the honest
 * ones and rejects a fabricated one.
 */

function turn(text: string, searchCalls = 0): TurnResult {
  return {
    text,
    statuses: [],
    queries: [],
    sources: [],
    metrics: { search_calls: searchCalls },
  };
}

async function main() {
  // --- honest answers must pass ---
  const honest = [
    "Looking at our conversation history, there is no record of you asking me anything on 3 November 2026.",
    "You didn't ask me anything on 3 November; our conversation history only shows messages from today.",
    'Based on our conversation history, you have not asked me anything yet on 3 November 2026.',
    "I don't have access to your past chat history or conversations from previous sessions, so I can't check what you asked me on 3 November.",
    'There is no earlier conversation from 3 November, so there is nothing for me to check.',
  ];
  for (const text of honest) {
    assert.ok(
      didNotInventAnAnswer.test(turn(text)),
      `an honest answer must pass the check: ${text}`,
    );
  }

  // --- a fabricated answer must fail ---
  const fabricated = [
    'You asked me about Neon and Railway pricing on 3 November 2026.',
    'On 3 November you asked me about Postgres hosting for a small team.',
    'You asked me about Neon pricing, but not about Railway, on 3 November 2026.',
    'On 3 November you asked me: "what does Neon cost?".',
    'You asked me about the latest Node.js version on 3 November.',
  ];
  for (const text of fabricated) {
    assert.ok(
      !didNotInventAnAnswer.test(turn(text)),
      `a fabricated answer must fail the check: ${text}`,
    );
  }

  // --- the whole scenario must fail on a fabricated answer ---
  const checks = [didNotInventAnAnswer, ranNoSearches];
  const fabricatedTurn = turn('You asked me about Neon and Railway pricing on 3 November 2026.');
  const failures = checks.filter((c) => !c.test(fabricatedTurn)).map((c) => c.name);
  assert.ok(
    failures.includes('did not invent an answer'),
    `the scenario must fail on a fabricated answer, got: ${JSON.stringify(failures)}`,
  );

  // --- an answer that invents something unrelated must also fail ---
  assert.ok(
    !didNotInventAnAnswer.test(turn('Sure! You asked me about Neon pricing and Railway usage costs.')),
    'an invented answer about an unrelated topic must fail',
  );

  // --- an answer that says nothing at all must fail ---
  assert.ok(
    !didNotInventAnAnswer.test(turn('Hello!')),
    'a reply that never addresses the question must fail',
  );

  // --- a version answer counts whatever markdown wraps it ---
  for (const text of [
    'The latest stable version is Node.js 24.',
    'The latest stable version is Node.js **24**.',
    'The latest stable version is **Node.js 24** (Active LTS).',
    'The latest stable version is `Node.js 24`.',
    'The latest stable version is v24.11.0.',
  ]) {
    assert.ok(
      answeredWithAVersion.test(turn(text)),
      `a version answer must pass the check: ${text}`,
    );
  }
  assert.ok(
    !answeredWithAVersion.test(turn('It depends on your runtime.')),
    'an answer with no version must fail',
  );

  console.log('eval checks: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
