import type { Database } from "./database";
import type { MuseBindingRow } from "./schema";

export async function bindRedeemedAgent(
  db: Database,
  registrationId: string,
  agentId: string,
): Promise<void> {
  const binding = await db.one<MuseBindingRow>(
    "UPDATE musecity.muse_bindings SET agent_id=$2 WHERE registration_id=$1 AND ended_at IS NULL RETURNING *",
    [registrationId, agentId],
  );
  if (binding)
    await db.query(
      "UPDATE musecity.agents SET public_visible=true,description=$2 WHERE id=$1 AND owner_account_id=$3",
      [agentId, binding.description, binding.account_id],
    );
}
