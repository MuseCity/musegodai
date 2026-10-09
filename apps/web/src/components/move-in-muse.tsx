import { Link } from "react-router";
import { AgentConnection } from "./agent-connection";
import type { OnboardingState } from "../shared/onboarding";

export function MoveInMuse({
  state,
  onDirty,
  onBusy,
  refresh,
}: {
  state: OnboardingState["muse"];
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  refresh: () => Promise<void>;
}) {
  return (
    <>
      <p className="move-in-description">
        A Muse is an AI Agent you already use. Copy a connection prompt and
        paste it into your Agent. You can also do this later.
      </p>
      {state.status === "activated" ? (
        <div className="move-in-success" role="status">
          <strong>{state.agent?.name} is connected.</strong>
          <p>
            Manage your Muse in{" "}
            <Link className="text-link" to="/me/agents">
              My agents
            </Link>
            .
          </p>
        </div>
      ) : (
        <AgentConnection
          onDirty={onDirty}
          onBusy={onBusy}
          onConnected={refresh}
        />
      )}
    </>
  );
}
