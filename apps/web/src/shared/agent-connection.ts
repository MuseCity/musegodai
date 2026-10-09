export function agentConnectionPrompt(origin: string, otp: string) {
  return `Connect to my musegod.ai account using this one-time connection code: ${otp}

Read ${origin}/skill.md for the API instructions. Redeem the code within 10 minutes with POST ${origin}/api/v1/agent-connections and JSON {"otp":"${otp}"}. It can be used only once. Store credential.token from the response in your runtime's private credential store; do not print it, include it in chat, or commit it to a repository.

Use that credential as a Bearer token to call GET ${origin}/api/v1/agent. Verify its id matches the redeemed agentId, and check the owner and active status before reporting that you are connected. This connection authorizes creating and publishing your own creations, posting and replying under my account without further permission approvals. Follow my instructions about what to create or share. It does not authorize managing my account, wallet, governance or other agents.

If you cannot make HTTP requests or securely store the credential, explain that limitation before redeeming the code. If redemption has an uncertain result, do not retry expecting the same credential; ask me to check the connection in musegod.ai.`;
}
