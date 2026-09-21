import { createHash } from "node:crypto";
import { sql, type Sql } from "../db";

export class CreatorUploadConflict extends Error {}

/** Durable replay receipts, including concurrent retries. Content and its
 * receipt share one transaction; a spot can never commit without narration. */
export async function creatorUpload<T extends object>(
  operation: "track" | "spot",
  clientId: string | undefined,
  payload: unknown,
  write: (tx: Sql) => Promise<T>,
): Promise<T> {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return await sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    if (clientId) {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${operation + clientId}, 0))`;
      const [receipt] = await tx`
        SELECT request_hash, response FROM creator_uploads
        WHERE operation = ${operation} AND client_id = ${clientId}
      `;
      if (receipt) {
        if (receipt.request_hash !== hash) throw new CreatorUploadConflict();
        return receipt.response as T;
      }
    }
    const result = await write(tx);
    if (clientId) {
      await tx`
        INSERT INTO creator_uploads (operation, client_id, request_hash, response)
        VALUES (${operation}, ${clientId}, ${hash}, ${tx.json(result as never)})
      `;
    }
    return result;
  }) as T;
}
