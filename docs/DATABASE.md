# Database

The initial migration creates `profiles`, `conversations`, `conversation_members`, and `messages`. Membership is the authorization boundary: clients can only select conversations and messages for conversations where `auth.uid()` is a member. `messages.sender_id` must match the authenticated user on insert.

Permanent message history is server-side and ordered by `created_at`. `messages.client_id` plus its sender-scoped unique constraint makes retries idempotent. The current client reads the newest 100 messages; cursor pagination should be added before large-scale production use.

The production-contract migration adds private `message-media` storage, attachment metadata, delivery receipts, blocks, reports, an admin-member flag, and a leave-conversation function. Storage paths are user-scoped and private; production upload code must still validate MIME type and size before inserting metadata.
