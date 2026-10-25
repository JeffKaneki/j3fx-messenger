# Security

Apply the migration with a trusted deployment process. RLS must remain enabled. The client may contain only the Supabase URL and anon/publishable key; the service-role key belongs in Edge Function secrets only.

Private media must use a non-public bucket and short-lived signed URLs. Validate MIME type and size server-side. Account deletion, reports, administrative recovery, and retention must be implemented as audited Edge Functions before production launch.

The production-contract migration creates a private `message-media` bucket and user-scoped object policies. It does not grant a browser direct access to another user's files; a production download flow should authorize conversation membership and issue a short-lived signed URL from an Edge Function.
