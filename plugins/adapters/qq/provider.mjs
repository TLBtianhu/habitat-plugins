export function createHandlers({ onebotClient, policy, getResidenceContext }) {
  return {
    reply: async (args) => {
      const context = getResidenceContext();
      const decision = policy.authorizeReply(context, args);
      const result = context.kind === 'group'
        ? await onebotClient.sendGroupMsg(Number(context.peerId), args.text)
        : await onebotClient.sendPrivateMsg(Number(context.peerId), args.text);
      policy.noteOutput(context.residenceId);
      return { ...result, residenceId: context.residenceId, decisionReason: decision.reason };
    },
  };
}
