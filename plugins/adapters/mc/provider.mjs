export function createHandlers({ client }) {
  return {
    obs: () => client.obs(),
    say: (args) => client.act({ verb: 'mc.say', args: { text: args.text } }),
    look: (args) => client.act({ verb: 'look', args }),
    stop: () => client.act({ verb: 'stop', args: {} }),
  };
}
