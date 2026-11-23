import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvents, dailySeries, dayKey, emptyStats, pruneStats, sanitizeStats, sumCounts, topSites } from '../src/shared/stats-model.ts';
import { MAX_SITE_STATS, STATS_RETENTION_DAYS } from '../src/shared/constants.ts';

test('events aggregate per category, day and site', () => {
  const s = emptyStats();
  applyEvents(s, [{ category: 'ads', site: 'news.com' }, { category: 'trackers', site: 'news.com' }, { category: 'ads', site: null, count: 3 }], '2026-11-18');
  assert.deepEqual(s.totals, { ads: 4, trackers: 1 });
  assert.equal(sumCounts(s.daily['2026-11-18']), 5);
  assert.equal(s.sites['news.com']!.total, 2);
  assert.deepEqual(s.sites['news.com']!.byCategory, { ads: 1, trackers: 1 });
  assert.equal(Object.keys(s.sites).length, 1, 'events without a site are not attributed');
});

test('pruning keeps the retention window and the busiest sites', () => {
  const s = emptyStats();
  const today = new Date(2026, 10, 18);
  const old = new Date(today);
  old.setDate(old.getDate() - STATS_RETENTION_DAYS - 1);
  s.daily[dayKey(old)] = { ads: 1 };
  s.daily[dayKey(today)] = { ads: 1 };
  for (let i = 0; i < MAX_SITE_STATS + 20; i++) s.sites[`s${i}.com`] = { total: i, byCategory: {}, last: '2026-11-18' };
  pruneStats(s, today);
  assert.deepEqual(Object.keys(s.daily), [dayKey(today)]);
  assert.equal(Object.keys(s.sites).length, MAX_SITE_STATS);
  assert.ok(!('s0.com' in s.sites));
  assert.equal(topSites(s, 1)[0]!.host, `s${MAX_SITE_STATS + 19}.com`);
});

test('daily series fills empty days, oldest first', () => {
  const s = emptyStats();
  const today = new Date(2026, 10, 18);
  s.daily['2026-11-17'] = { trackers: 2 };
  const series = dailySeries(s, 3, today);
  assert.deepEqual(series.map((d) => d.day), ['2026-11-16', '2026-11-17', '2026-11-18']);
  assert.deepEqual(series[1]!.counts, { trackers: 2 });
  assert.deepEqual(series[2]!.counts, {});
});

test('stats sanitizer migrates v1 totals and rejects garbage', () => {
  const migrated = sanitizeStats(undefined, { totalBlocked: 42, since: 123 });
  assert.equal(sumCounts(migrated.totals), 42);
  assert.equal(migrated.since, 123);
  const garbage = sanitizeStats({ version: 7, totals: 'x' });
  assert.equal(garbage.version, 2);
  assert.deepEqual(garbage.totals, {});
});
