# Administrative recovery

No administrative recovery path is enabled by the initial client. Recovery must be implemented as a separately authorized Supabase Edge Function with MFA-protected operator accounts, a reason and ticket identifier, least-privilege access, immutable audit logs, and an expiry/retention policy. Operators must never receive user passwords or the service-role key in the browser.
