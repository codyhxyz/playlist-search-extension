// Local-only engagement, not analytics. One worker serializes writes across tabs.
export const REVIEW_KEY = 'plsReview';
const DAY_MS = 86_400_000;

/** @typedef {{saves: number, days: number, firstDay: number, lastDay: number, prompted: boolean}} ReviewState */

/** @param {ReviewState} s @param {number} day */
function eligible(s, day) {
  return !s.prompted && s.saves >= 5 && s.days >= 3 && day - s.firstDay >= 7;
}

/** @param {{get: Function, set: Function}} storage */
export function createReviewTracker(storage, now = Date.now) {
  let queue = Promise.resolve();
  /** @param {'save' | 'claim'} action */
  return function review(action) {
    const run = queue.then(async () => {
      const day = Math.floor(now() / DAY_MS);
      const stored = (await storage.get(REVIEW_KEY))?.[REVIEW_KEY];
      /** @type {ReviewState} */
      const s = stored && ['saves', 'days', 'firstDay', 'lastDay'].every(
        (key) => Number.isSafeInteger(stored[key]) && stored[key] >= 0,
      ) ? { ...stored } : { saves: 0, days: 0, firstDay: day, lastDay: day, prompted: false };
      if (s.prompted) return false;
      if (action === 'save') {
        if (!s.saves) { s.firstDay = day; s.days = 1; }
        else if (day > s.lastDay) s.days = Math.min(3, s.days + 1);
        s.lastDay = Math.max(day, s.lastDay);
        s.saves = Math.min(5, s.saves + 1);
      } else {
        if (!eligible(s, day)) return false;
        // Claim before showing: two tabs cannot both ask, and closing the sheet,
        // dismissing, or opening the store all mean we never ask again.
        s.prompted = true;
      }
      await storage.set({ [REVIEW_KEY]: s });
      return action === 'claim' || eligible(s, day);
    });
    queue = run.then(() => {}, () => {});
    return run;
  };
}
