import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createActivity, MIN_ACTIVE_MS, trackIndexing } from './activity';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function watched() {
  const activity = createActivity();
  const seen: (string | null)[] = [];
  activity.subscribe((label) => seen.push(label));
  return { activity, seen };
}

test('a short activity stays on for the minimum time', () => {
  const { activity, seen } = watched();
  activity.pulse('Learning');
  vi.advanceTimersByTime(MIN_ACTIVE_MS - 1);
  expect(seen).toEqual([null, 'Learning']);
  vi.advanceTimersByTime(1);
  expect(seen).toEqual([null, 'Learning', null]);
});

test('a long activity stops as soon as it ends', () => {
  const { activity, seen } = watched();
  const end = activity.begin('Indexing');
  vi.advanceTimersByTime(MIN_ACTIVE_MS * 3);
  end();
  expect(seen).toEqual([null, 'Indexing', null]);
});

test('overlapping activities: the latest one shows, idle only when all ended', () => {
  const { activity, seen } = watched();
  const indexing = activity.begin('Indexing');
  const weights = activity.begin('Weights');
  vi.advanceTimersByTime(MIN_ACTIVE_MS);
  weights();
  weights();
  expect(seen).toEqual([null, 'Indexing', 'Weights', 'Indexing']);
  indexing();
  expect(seen.at(-1)).toBeNull();
});

test('indexing events turn the activity on and off', () => {
  const { activity, seen } = watched();
  let send: (active: boolean) => void = () => {};
  const unsubscribe = vi.fn();
  const stop = trackIndexing(
    {
      onIndexing(listener) {
        send = listener;
        return unsubscribe;
      },
    },
    activity,
  );
  send(false);
  send(true);
  send(true);
  vi.advanceTimersByTime(MIN_ACTIVE_MS);
  send(false);
  expect(seen).toEqual([null, 'Indexing', null]);
  send(true);
  stop();
  vi.advanceTimersByTime(MIN_ACTIVE_MS);
  expect(seen.at(-1)).toBeNull();
  expect(unsubscribe).toHaveBeenCalled();
});
