# J3FX Messenger

J3FX is an original React/TypeScript messenger using Supabase Auth, PostgreSQL, Row Level Security, and Realtime. One shared frontend targets the web, Android (Capacitor), and Windows desktop (Electron).

## Run locally

1. Install Node.js 20 or newer. This workspace was verified with Node.js `v25.9.0` and npm `11.12.1`.
2. Create a Supabase project.
3. Copy `.env.example` to `.env` and set `VITE_SUPABASE_URL` plus the browser-safe publishable/anon key.
4. For a fresh project, run every SQL migration in `supabase/migrations/` in filename order. For an existing project, apply only migrations it has not run yet.
5. In Supabase Auth, configure the site URL and redirect URLs for `http://localhost:5173` and your deployed URL. Decide whether email confirmation is required.
6. Run `npm install`, then `npm run dev`.
7. Register two accounts. Start a conversation by entering the other account's generated username; the username is shown in the profile chip and can also be read from the `profiles` table.

The Vite development command forces dependency re-optimization at startup. If an already-running dev server shows a blank page with `504 (Outdated Optimize Dep)`, stop that server and restart it with `npm run dev`.

Only the publishable/anon key belongs in the browser. Never put a service-role key in `.env`, source code, or a static host.

## Web, Android, and Windows builds

The web app remains the primary shared UI:

- Web development: `npm run dev`
- Production web bundle: `npm run build`
- Android project: already generated in `android/`; after changing web code, run `npm run android:sync`.
- Windows installer and portable executable: `npm run desktop:dist`.

### Voice and video calls (peer-to-peer WebRTC)

Calls use the browser's built-in WebRTC APIs. Audio/video media flows directly between the two participants when the network permits; Supabase carries only authenticated call invitations, SDP, and ICE connection signaling—not the audio or video. The media path does not use Daily or another per-minute calling SDK.

**Call setup**

1. Apply `supabase/migrations/20261025221500_peer_webrtc_calls.sql` to an existing Supabase project. On a new project, run all migrations in filename order. This migration replaces the old temporary Daily call-session table.
2. Deploy the authenticated call/signaling function: `npx supabase functions deploy j3fx-calls --project-ref YOUR_PROJECT_REF`. It uses Supabase's standard server-side function secrets; do not add service-role credentials to frontend environment variables.
3. Build the web app with `npm run build`. Audio/video call buttons work in direct conversations only; group calls are not implemented.
4. Optional TURN relay: run Coturn or another TURN service that supports time-limited HMAC credentials. Configure `TURN_URLS` (comma-separated `turn:`/`turns:` URLs) and `TURN_SHARED_SECRET` in Supabase Edge Function Secrets. The function issues one-hour credentials per authenticated user. Never put the shared secret in `.env` or the app bundle. Without TURN, calls work only on networks that permit a direct ICE connection; some carrier, corporate, or symmetric-NAT networks require TURN.

**Low-data behavior and limits**

- Audio calls request audio only and never access the camera.
- Incoming calls play `public/ringtone.mp3` while the app is open. To change the sound, put an MP3 named `ringtone.mp3` in the root `public/` folder (replace the file when changing it). If that file is missing, the built-in two-tone fallback is used. If the browser/WebView blocks autoplay, the incoming-call prompt provides an **Enable ringtone** button. Background/closed-app ringing requires push notifications and is not included.
- Video requests up to 320×240 at 12 FPS, caps the initial video sender bitrate at 180 kbit/s, reduces it when measured network quality is poor, and offers an audio-only fallback. Actual usage varies by codec, network, packet overhead, and the remote peer; it is not guaranteed to be lower than a hosted SDK.
- Declined and missed calls, plus ended calls with their accepted-to-ended duration, appear inline in the same timestamp-sorted conversation timeline as messages. Images can be previewed and downloaded; other attachments open as downloads with their original filename. Attachments are limited to 50 MB. When the recipient declines, the caller sees a brief decline screen before returning to the chat.
- Public STUN is used for address discovery. TURN is optional relaying for restrictive networks. Coturn is free/open-source software, but a hosted server, bandwidth, and egress may cost money.
- WebRTC secures media transport between peers, but this app does not add application-level end-to-end encryption. Signaling includes SDP and ICE candidates, which can expose network address information to the other participant. No call recording is implemented.

**Platform support**

- Web and Windows Electron use browser WebRTC directly.
- Electron refreshes the signed-in Supabase session before call-service requests. If the call service still reports an invalid session, sign out and back in on desktop to renew the stored refresh token.
- Electron retries video capture with default camera constraints and can continue a video call as audio-only if its camera source cannot start; camera access still needs verification on each Windows machine.
- Android uses the Capacitor WebView's WebRTC implementation and requests microphone/camera permissions at runtime.
- The supplied `src/assets/app icon.jpg` is used to generate the Windows `.ico` and Android launcher icons.
- The iOS Capacitor project includes microphone/camera usage descriptions; WebRTC support requires a recent iOS/WKWebView. Building/signing the iOS app requires macOS and Xcode, which are not available on Windows.
- This repository is Vite + React + Capacitor + Electron, not Expo or React Native. It does not use Expo Go or `react-native-webrtc`.

Test calls using two signed-in devices/accounts. Verify permissions, audio routing, poor-network behavior, and TURN fallback on real devices before release. No automated test in this repository can prove successful NAT traversal across all networks.

### Android APK

1. Install Android Studio and its Android SDK Platform/Build Tools. Install JDK 21 if it is not already available.
2. Set `ANDROID_HOME` or `ANDROID_SDK_ROOT` to the Android SDK location. On Windows, restart the terminal after setting the variable.
3. Register the Android app in Firebase using package ID `com.j3fx.messenger`, then put the downloaded `google-services.json` at `android/app/google-services.json`.
   
   This project uses Capacitor's Push Notifications plugin rather than manually initializing the Firebase Android SDK. The project-level Google Services Gradle plugin and app-level plugin application are already configured, and the Capacitor plugin supplies the Firebase Messaging Android dependency. Do not add a second Firebase BoM or another `firebase-messaging` dependency from the generic Firebase setup wizard unless adding a different native Firebase product.
4. Apply `supabase/migrations/20261026000000_firebase_push_notifications.sql` to the Supabase project.
5. In Google Cloud IAM, create a server service account with the Firebase Cloud Messaging API Admin role and generate its private key. Keep the downloaded key private. Add these Edge Function secrets in Supabase **Project Settings > Edge Functions > Secrets**:
   - `FIREBASE_PROJECT_ID` — `project_info.project_id` from `google-services.json`.
   - `FIREBASE_CLIENT_EMAIL` — the service account `client_email`.
   - `FIREBASE_PRIVATE_KEY` — the service account `private_key`, including its PEM header/footer.
   
   Never put the service-account key in `.env`, frontend code, the APK, source control, or chat.
6. Deploy the authenticated push and call functions with the Supabase CLI, using your project reference:
   ```powershell
   npx supabase functions deploy j3fx-push --project-ref YOUR_PROJECT_REF
   npx supabase functions deploy j3fx-calls --project-ref YOUR_PROJECT_REF
   ```
   The `j3fx-calls` function sends incoming-call notifications. `j3fx-push` validates a newly sent message before notifying other conversation members. Notifications contain generic message text, not the message body.
7. Build with `npm run android:apk`. The debug APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`. Install it on an Android device with Google Play services and allow notifications when prompted.
8. The app creates Android **Incoming calls** and **Messages** notification channels. Incoming-call sound is sourced from `public/ringtone.mp3`; Android users can change the channel sound or disable it in system settings. A call notification tap opens the app's normal accept/decline screen. Android notification buttons over other apps and full-screen call UI are not implemented; Android restricts those behaviors and they require additional native call-notification handling.
9. For Play Store or public distribution, create a release signing key and configure signing in Android Studio/Gradle; do not commit the keystore or passwords.
10. In Supabase Auth URL Configuration, add `com.j3fx.messenger://auth/callback` as an allowed redirect URL for native email confirmation.

FCM sends notifications while the app is backgrounded or closed; it does not keep the app continuously running. Android 13+ requires notification permission, and notification delivery depends on Google Play services, device settings, and network availability. The push implementation currently targets Android; iOS requires APNs setup and web/Windows need separate push integrations.

### Windows EXE

Run `npm run desktop:dist`. Outputs are written under `release/` as an NSIS installer and a portable `.exe`. The app uses a sandboxed Electron window with context isolation and no Node integration in the renderer. The EXE is unsigned by default; Windows SmartScreen may warn until a trusted code-signing certificate is configured.

The same React interface and Supabase backend are used on all targets. Android file selection, browser opening, hardware back navigation, and email callback deep links use Capacitor plugins. The Windows target is Electron; iOS uses Capacitor but must be built with Xcode. Android background push requires the Firebase and Supabase setup above; push notifications are not yet implemented for iOS, web, or Windows. The desktop and mobile apps require network access to reach Supabase; packaging does not make messaging offline-capable.

## Implemented and verified

- Email/password sign-up and sign-in, session restoration, and sign-out.
- Profile bootstrap with unique generated usernames.
- Membership-authorized persistent direct conversations.
- Server-authorized group conversation creation for up to 49 other members.
- Server timestamps and sender-scoped idempotency keys.
- Realtime inserts, edits, and reactions.
- Offline text outbox with reconnect retry and malformed-storage protection.
- Cursor-based loading of older messages.
- Sender-only edit and soft-delete controls.
- Heart reactions and per-conversation read cursors.
- Responsive web UI, conversation search, and production TypeScript/Vite build.
- Database contracts for delivery receipts, private message media, blocking, reporting, and leaving conversations.
- Web controls for blocking/reporting direct-chat users and leaving conversations.
- Group member add/remove controls, private file upload metadata, delivered-receipt writes, and account deletion control.
- Attachment picker/upload, signed URL opening for authorized storage objects, and visible sent/delivered/read status.
- Live people search by display name or username, message search within a conversation, presence timestamps, profile-photo upload, local chat themes, and per-conversation nicknames.
- Inbox-wide realtime updates when messages, membership, or profile changes occur.
- Center-cropped 1:1 profile-photo confirmation and receiver-authorized private attachments with image preview and download.
- A 5-second synchronization fallback repairs missed Realtime events without requiring a browser reload.
- One-to-one peer-to-peer WebRTC calls with authenticated Supabase signaling, low-data video constraints, audio-only fallback, and optional temporary TURN credentials.

## Manual setup you must complete

1. Open `.env` and enter `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from Supabase Project Settings > API. Do not enter the service-role key.
2. Open the Supabase SQL Editor and run all migration files in `supabase/migrations` in filename order.
3. In Supabase Auth > URL Configuration, set Site URL to `http://localhost:5173` for local use and add your deployed URL to Redirect URLs.
4. Create two test accounts, then use the generated usernames to test direct and group conversations.
5. Test Storage policies in a disposable project before production. The browser upload is private and signed URLs expire quickly.
6. Apply the peer-WebRTC call migration and deploy `j3fx-calls` as described above before testing calls. Configure an optional TURN relay for networks that block direct connections.
7. For Android push, add the Firebase configuration, apply the push-device migration, set the three server-side Firebase secrets, and deploy `j3fx-push` and `j3fx-calls` as described above.
8. Before launch, configure backups/retention, review account deletion and admin recovery, and run RLS/security tests.
9. Before mobile or desktop release, test authentication redirects, image/file upload, app resume, poor connectivity, message delivery, and calls on actual target devices. Test Android push with the app foregrounded, backgrounded, and force-stopped, and verify denied notification permission and expired device-token behavior.

## Not automatable in this repository

Firebase/Supabase account access, server-side service-account secrets, deployment, Android SDK setup, release signing credentials, and physical-device testing must be supplied locally. iOS packaging requires a Mac and Xcode. Android push is implemented in this repository but cannot deliver until the push migration and Edge Functions are deployed and the Firebase server secrets are configured. Safe link previews should run in a Supabase Edge Function. These are the remaining major requirements that cannot be completed safely without your external accounts, signing credentials, infrastructure, and devices.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DATABASE.md](docs/DATABASE.md), [docs/SECURITY.md](docs/SECURITY.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), and [docs/TESTING.md](docs/TESTING.md).
