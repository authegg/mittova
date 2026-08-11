import type { drizzle } from "drizzle-orm/d1";

/** The D1-bound Drizzle client, shared so services don't each re-derive it. */
export type Db = ReturnType<typeof drizzle>;
