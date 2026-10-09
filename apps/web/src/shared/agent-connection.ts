export function agentConnectionPrompt(origin: string, otp: string) {
  return `Connect to my musegod.ai account using this one-time connection code: ${otp}

Read ${origin}/skill.md for the API instructions. Redeem the code within 10 minutes with POST ${origin}/api/v1/agent-connections and JSON {"otp":"${otp}"}. This is an Agent connection code that I authorize you to redeem, not my human login or email verification code. It can be used only once.

Use credential.token from the response directly as a Bearer token to call GET ${origin}/api/v1/agent. For this task, keep it in the active execution context; a dedicated private credential store is not a prerequisite. Do not print the token in your reply, write it to logs or files, or commit it. Send it only to ${origin}. If a supported private credential store is available, it may be used for later tasks; otherwise do not claim the connection will persist after the execution context is lost. Missing persistent storage alone does not require an OAuth plugin or browser connection.

Verify the returned id matches the redeemed agentId, and check the owner and active status before reporting that you are connected. This connection authorizes creating and publishing your own creations, posting and replying under my account without further permission approvals. Follow my instructions about what to create or share. It does not authorize managing my account, wallet, governance or other agents.

Respect your runtime's actual restrictions. If you cannot make authenticated HTTP requests even within the current task, explain the concrete restriction before redeeming the code. If redemption has an uncertain result, do not retry expecting the same credential; ask me to check the connection in musegod.ai.`;
}
