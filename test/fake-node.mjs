export const b64 = (s) => Buffer.from(s).toString("base64");

export const result = (nonce, rc, out, err, outBytes = Buffer.byteLength(out), errBytes = Buffer.byteLength(err)) =>
  `MCPB_${nonce}:${rc}:${outBytes}:${errBytes}:${b64(out)}:${b64(err)}:MCPE_${nonce}`;

export const decodeWrapper = (line) => Buffer.from(/printf %s '([^']+)'/.exec(line)[1], "base64").toString("utf8");

export const frameText = (frame) => frame.replace(/^0:\d+:/, "");

export const isCommandFrame = (frame) => frameText(frame).startsWith("eval ");

export function createNodeBehavior({ identity, execute, ignoreProbes = 0, loginOk = true }) {
  const state = { probes: 0, commands: 0, passwordAttempts: 0, step: "auth" };
  const motd = "Linux pve 6.8\r\n";
  const prompt = "\x1b[?2004hroot@pve:~# ";
  const handle = (data, reply) => {
    if (state.step === "auth") {
      state.step = identity.kind === "linux" ? "user" : "shell";
      reply(identity.kind === "linux" ? "OK\r\npve login: " : "OK" + motd + prompt);
      return;
    }
    if (data === "2") return;
    const text = frameText(data);
    if (state.step === "user") {
      state.step = "password";
      reply(text + "\rPassword: ");
    } else if (state.step === "password") {
      state.passwordAttempts++;
      if (loginOk) {
        state.step = "shell";
        reply("\r\n" + motd + prompt);
      } else {
        state.step = "user";
        reply("\r\nLogin incorrect\r\n\r\npve login: ");
      }
    } else if (text.startsWith("printf '%s_%s")) {
      state.probes++;
      const nonce = /MCPRDY (\w+)/.exec(text)[1];
      reply(state.probes > ignoreProbes ? `${text}\rMCPRDY_${nonce}\r\n${prompt}` : "");
    } else if (text.startsWith('eval "$(printf %s')) {
      state.commands++;
      const wrapper = decodeWrapper(text);
      const nonce = /MCPB (\w+)/.exec(wrapper)[1];
      const command = Buffer.from(/printf %s '([^']+)' \| base64 -d > /.exec(wrapper)[1], "base64").toString();
      const out = execute(command);
      reply(text.replace("\n", "\r\n") + result(nonce, out.rc, out.out, out.err) + "\r\n" + prompt);
    }
  };
  return { state, handle };
}
