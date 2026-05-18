import postgres from "postgres";
import { env } from "./env";

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
});
