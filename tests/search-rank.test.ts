/**
 * Deterministic search ranking tests.
 *
 * Verifies:
 *   - Pinned cards sort first (+500)
 *   - Exact title match (+100)
 *   - Title token matches (+40 each, cap +120)
 *   - Tag exact matches (+25 each, cap +100)
 *   - Pack allowed_tags boost (+10 each, cap +50)
 *   - Text substring match (+30)
 *   - Stable tiebreak (artifact_id then title)
 *   - Case-insensitive matching
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreArtifact,
  rankArtifacts,
  SCORE_PINNED,
  SCORE_EXACT_TITLE,
  SCORE_TITLE_TOKEN,
  SCORE_TITLE_TOKEN_CAP,
  SCORE_TAG_MATCH,
  SCORE_TAG_MATCH_CAP,
  SCORE_PACK_TAG,
  SCORE_PACK_TAG_CAP,
  SCORE_TEXT_SUBSTRING,
  type ScoredArtifact,
} from '../src/kb/search_rank.js';
import type { VaultContext } from '../src/kb/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<VaultContext>): VaultContext {
  return {
    activePack: null,
    pinHashes: [],
    policies: { search_boost: 0 },
    ...overrides,
  };
}

function makeArtifact(overrides?: Partial<ScoredArtifact>): ScoredArtifact {
  return {
    artifact_id: 'card_default',
    title: 'Default Title',
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Score constants verification
// ---------------------------------------------------------------------------

describe('search_rank score constants', () => {
  it('exports correct constant values', () => {
    assert.equal(SCORE_PINNED, 500);
    assert.equal(SCORE_EXACT_TITLE, 100);
    assert.equal(SCORE_TITLE_TOKEN, 40);
    assert.equal(SCORE_TITLE_TOKEN_CAP, 120);
    assert.equal(SCORE_TAG_MATCH, 25);
    assert.equal(SCORE_TAG_MATCH_CAP, 100);
    assert.equal(SCORE_PACK_TAG, 10);
    assert.equal(SCORE_PACK_TAG_CAP, 50);
    assert.equal(SCORE_TEXT_SUBSTRING, 30);
  });
});

// ---------------------------------------------------------------------------
// scoreArtifact
// ---------------------------------------------------------------------------

describe('scoreArtifact', () => {
  it('returns 0 for empty query and no matching context', () => {
    const { score, pinned } = scoreArtifact('unrelated', makeArtifact(), makeCtx());
    assert.equal(pinned, false);
    assert.equal(score, 0);
  });

  it('adds SCORE_PINNED when card hash is in pinHashes', () => {
    const { score, pinned } = scoreArtifact(
      'anything',
      makeArtifact({ hash: 'abc123' }),
      makeCtx({ pinHashes: ['abc123', 'other'] })
    );
    assert.equal(pinned, true);
    assert.ok(score >= SCORE_PINNED);
  });

  it('does not pin when hash is absent from pinHashes', () => {
    const { pinned } = scoreArtifact(
      'anything',
      makeArtifact({ hash: 'abc123' }),
      makeCtx({ pinHashes: ['other'] })
    );
    assert.equal(pinned, false);
  });

  it('adds SCORE_EXACT_TITLE for case-insensitive exact match', () => {
    const { score } = scoreArtifact(
      'My Card Title',
      makeArtifact({ title: 'my card title' }),
      makeCtx()
    );
    assert.ok(score >= SCORE_EXACT_TITLE);
  });

  it('adds title token matches capped at SCORE_TITLE_TOKEN_CAP', () => {
    // Query has 4 tokens, all found in title => 4*40=160, but cap at 120
    const { score } = scoreArtifact(
      'alpha beta gamma delta',
      makeArtifact({ title: 'alpha beta gamma delta extra' }),
      makeCtx()
    );
    // Should get title token cap (120) + text substring (30) + maybe exact title (no, extra word)
    // Title tokens: all 4 match → cap at 120
    // Text: "alpha beta gamma delta" found in title → +30
    assert.ok(score >= SCORE_TITLE_TOKEN_CAP, `Expected >= ${SCORE_TITLE_TOKEN_CAP}, got ${score}`);
    // Verify cap works (should not exceed cap + text_substring)
    assert.ok(
      score <= SCORE_TITLE_TOKEN_CAP + SCORE_TEXT_SUBSTRING,
      `Expected <= ${SCORE_TITLE_TOKEN_CAP + SCORE_TEXT_SUBSTRING}, got ${score}`
    );
  });

  it('adds tag matches capped at SCORE_TAG_MATCH_CAP', () => {
    // Query has 5 tokens matching tags => 5*25=125, capped at 100
    const artifact = makeArtifact({
      tags: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
    });
    const { score } = scoreArtifact('alpha beta gamma delta epsilon', artifact, makeCtx());
    // Tag matches: all 5 match → capped at 100
    assert.ok(score >= SCORE_TAG_MATCH_CAP, `Expected >= ${SCORE_TAG_MATCH_CAP}, got ${score}`);
  });

  it('adds pack tag boost capped at SCORE_PACK_TAG_CAP', () => {
    const artifact = makeArtifact({
      tags: ['smoke', 'demo', 'release', 'beta', 'alpha', 'test'],
    });
    const ctx = makeCtx({
      policies: {
        search_boost: 0,
        allowed_tags: ['smoke', 'demo', 'release', 'beta', 'alpha', 'test'],
      },
    });
    const { score } = scoreArtifact('unrelated', artifact, ctx);
    // 6 pack tags match → 6*10=60, capped at 50
    assert.ok(score >= SCORE_PACK_TAG_CAP, `Expected >= ${SCORE_PACK_TAG_CAP}, got ${score}`);
    // Only pack tag boost applies (no other match), so exactly 50
    assert.equal(score, SCORE_PACK_TAG_CAP);
  });

  it('adds SCORE_TEXT_SUBSTRING for case-insensitive text match', () => {
    const { score } = scoreArtifact(
      'smoke testing',
      makeArtifact({ text: 'This is about Smoke Testing practices.' }),
      makeCtx()
    );
    assert.ok(score >= SCORE_TEXT_SUBSTRING);
  });

  it('uses title as fallback text when text is undefined', () => {
    const { score } = scoreArtifact('default', makeArtifact({ title: 'Default Title' }), makeCtx());
    // "default" is in "Default Title" (case-insensitive) → +30
    // Also "default" token matches title → +40
    assert.ok(score >= SCORE_TEXT_SUBSTRING);
  });

  it('accumulates all score components correctly', () => {
    const artifact = makeArtifact({
      artifact_id: 'card_combo',
      title: 'smoke',
      tags: ['smoke'],
      hash: 'pinned-hash',
      text: 'This is about smoke',
    });
    const ctx = makeCtx({
      pinHashes: ['pinned-hash'],
      policies: {
        search_boost: 0,
        allowed_tags: ['smoke'],
      },
    });

    const { score, pinned } = scoreArtifact('smoke', artifact, ctx);
    assert.equal(pinned, true);

    // Expected: pinned(500) + exact_title(100) + title_token(40) + tag_match(25) + pack_tag(10) + text_substring(30) = 705
    const expected =
      SCORE_PINNED +
      SCORE_EXACT_TITLE +
      SCORE_TITLE_TOKEN +
      SCORE_TAG_MATCH +
      SCORE_PACK_TAG +
      SCORE_TEXT_SUBSTRING;
    assert.equal(score, expected, `Expected ${expected}, got ${score}`);
  });
});

// ---------------------------------------------------------------------------
// rankArtifacts
// ---------------------------------------------------------------------------

describe('rankArtifacts', () => {
  it('sorts by score descending', () => {
    const artifacts = [
      makeArtifact({ artifact_id: 'card_a', title: 'Unrelated', tags: [] }),
      makeArtifact({
        artifact_id: 'card_b',
        title: 'smoke demo',
        tags: ['smoke'],
      }),
    ];
    const ranked = rankArtifacts('smoke', artifacts, makeCtx());
    assert.equal(ranked[0].artifact_id, 'card_b');
    assert.equal(ranked[1].artifact_id, 'card_a');
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('pinned cards sort first', () => {
    const artifacts = [
      makeArtifact({
        artifact_id: 'card_unpinned',
        title: 'smoke exact match',
        tags: ['smoke'],
        hash: 'unpinned-hash',
      }),
      makeArtifact({
        artifact_id: 'card_pinned',
        title: 'other thing',
        tags: [],
        hash: 'pinned-hash',
      }),
    ];
    const ctx = makeCtx({ pinHashes: ['pinned-hash'] });
    const ranked = rankArtifacts('smoke', artifacts, ctx);
    assert.equal(ranked[0].artifact_id, 'card_pinned');
    assert.equal(ranked[0].pinned, true);
    assert.equal(ranked[1].pinned, false);
  });

  it('stable tiebreak by artifact_id then title', () => {
    // All three have the same score (0) for an unrelated query
    const artifacts = [
      makeArtifact({ artifact_id: 'card_c', title: 'Zebra' }),
      makeArtifact({ artifact_id: 'card_a', title: 'Yak' }),
      makeArtifact({ artifact_id: 'card_b', title: 'Xray' }),
    ];
    const ranked = rankArtifacts('unrelated', artifacts, makeCtx());
    assert.equal(ranked[0].artifact_id, 'card_a');
    assert.equal(ranked[1].artifact_id, 'card_b');
    assert.equal(ranked[2].artifact_id, 'card_c');
  });

  it('tiebreaks by title when artifact_ids match', () => {
    // Hypothetical: same id (shouldn't happen in practice, but tests stable sort)
    const artifacts = [
      makeArtifact({ artifact_id: 'card_same', title: 'Bravo' }),
      makeArtifact({ artifact_id: 'card_same', title: 'Alpha' }),
    ];
    const ranked = rankArtifacts('unrelated', artifacts, makeCtx());
    assert.equal(ranked[0].title, 'Alpha');
    assert.equal(ranked[1].title, 'Bravo');
  });

  it('is case-insensitive for all matching', () => {
    const artifacts = [
      makeArtifact({
        artifact_id: 'card_upper',
        title: 'SMOKE TESTING',
        tags: ['SMOKE'],
      }),
    ];
    const ranked = rankArtifacts('smoke testing', artifacts, makeCtx());
    // Should get exact title match + title tokens + tag match + text substring
    assert.ok(ranked[0].score >= SCORE_EXACT_TITLE);
  });

  it('returns empty array for empty input', () => {
    const ranked = rankArtifacts('anything', [], makeCtx());
    assert.equal(ranked.length, 0);
  });

  it('deterministic: same input always produces same output', () => {
    const artifacts = [
      makeArtifact({ artifact_id: 'card_1', title: 'Alpha', tags: ['a'] }),
      makeArtifact({ artifact_id: 'card_2', title: 'Beta', tags: ['b'] }),
      makeArtifact({ artifact_id: 'card_3', title: 'Alpha Beta', tags: ['a', 'b'] }),
    ];
    const ctx = makeCtx();

    // Run 10 times and compare
    const first = rankArtifacts('alpha', artifacts, ctx);
    for (let i = 0; i < 10; i++) {
      const result = rankArtifacts('alpha', artifacts, ctx);
      assert.equal(result.length, first.length);
      for (let j = 0; j < result.length; j++) {
        assert.equal(result[j].artifact_id, first[j].artifact_id);
        assert.equal(result[j].score, first[j].score);
      }
    }
  });

  it('pack tags boost artifacts with matching tags', () => {
    const artifacts = [
      makeArtifact({ artifact_id: 'card_tagged', title: 'Other', tags: ['approved'] }),
      makeArtifact({ artifact_id: 'card_plain', title: 'Other', tags: [] }),
    ];
    const ctx = makeCtx({
      policies: { search_boost: 0, allowed_tags: ['approved'] },
    });
    const ranked = rankArtifacts('unrelated', artifacts, ctx);
    // card_tagged gets pack tag boost, card_plain doesn't
    assert.ok(ranked[0].artifact_id === 'card_tagged');
    assert.ok(ranked[0].score > ranked[1].score);
  });
});
