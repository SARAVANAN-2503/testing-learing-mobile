# ZoujUp WebRTC browser diagnostic

This is an independent browser client for the production ZoujUp call API and realtime service. It tests the same call lifecycle and signaling events as Flutter, without running either backend locally.

## Run

```bash
cd "/Volumes/Mac/Home/Learning Mobile/webrtc-browser-diagnostic"
node server.mjs
```

Open the printed `https://localhost:8443` URL on the laptop. On the phone, install/trust the local CA from the printed HTTP port `8080` `/ca.crt` URL, then open the printed LAN HTTPS URL. HTTPS is mandatory for mobile camera and microphone access.

Opening through Live Server is fine for laptop-only checks, but use `node server.mjs` for the phone test. The page includes a local `socket.io.min.js`; if the call status says `Socket.IO client missing`, reload from the project folder URL or restart the server.

On both devices paste that account's production access token, or expand **Get a token using email OTP** to sign in.

For fresh temp-mail accounts, expand **Quick register test account**:

1. Enter temp email, name, known language, and language to learn.
2. Press **Register and send OTP**.
3. Paste the email OTP and press **Verify OTP + complete onboarding**.
4. Share User B's auto-filled **My user ID** with User A.
5. On User A, paste User B's ID into **Peer user ID for new conversation** and press **Create conversation**.
6. Share the generated conversation ID with User B.
7. Both users press **Mark conversation ready**.

After both devices have the same conversation ID, press **Connect realtime**. User A starts an audio call. User B accepts. Once audio connects, either user requests video and the other accepts.

## Interpret the result

- Browser-to-browser video works and both logs show `WEBRTC ONTRACK video RECEIVED`: production REST, realtime signaling, TURN/ICE, and video relay are working. The remaining defect is in the Flutter WebRTC negotiation/renderer path.
- Upgrade events arrive but an offer has no `video: [sendrecv]`, or the transceiver dump has `senderKind: null`: the sending client did not attach its camera track correctly.
- Offers and answers both advertise video, but neither browser gets `WEBRTC ONTRACK video RECEIVED`: inspect ICE/TURN and the realtime relay/negotiation IDs; this points away from rendering.
- A browser receives a video track but displays black: signaling succeeded; investigate track muted state, camera capture, codec, or rendering.
- REST or Socket.IO acks fail on both devices: the report contains the production error/code and points to the backend/realtime control plane.

Never share a report before confirming it contains no personal content. Tokens are automatically redacted.
