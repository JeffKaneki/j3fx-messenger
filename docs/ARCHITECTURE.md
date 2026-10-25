# Architecture

The web client is a Vite React application. Supabase Auth owns sessions; PostgreSQL is the source of truth for profiles, memberships, and messages; Realtime broadcasts database inserts/updates to an authorized conversation channel.

Messages are inserted before they are shown as accepted. Each outgoing message has a UUID `client_id`, and the `(sender_id, client_id)` unique constraint makes retries safe. When offline, the client stores the body and conversation ID in an outbox and retries after the browser emits `online`; server history remains unaffected by clearing browser storage.

Conversation access is membership-based through RLS. A production release should add cursor pagination, read cursors, receipt batching, private storage policies, moderation/report flows, and Edge Functions for push notifications and URL previews.
