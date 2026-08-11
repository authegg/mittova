import { useEffect, useMemo, useState } from "react";

/**
 * Slice a list into pages.
 *
 * Resets to the first page whenever the list shrinks past the current one —
 * deleting the last row of page three should show page two, not an empty table
 * with no way to tell that anything is there.
 */
export function usePaged<T>(items: T[], perPage = 25) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / perPage));

  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const slice = useMemo(
    () => items.slice(page * perPage, page * perPage + perPage),
    [items, page, perPage],
  );

  return { slice, page, pageCount, total: items.length, setPage };
}
