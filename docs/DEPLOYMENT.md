# Deployment

Build with `npm run build` and deploy the generated `dist` directory to a static host. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in the host's build environment. Add the deployed URL to Supabase Auth redirect URLs.

Expo Go is not applicable to this web client. Native Android/iOS support requires a separate Expo client sharing the Supabase schema and auth contract.

Apply every SQL file in `supabase/migrations` in filename order. Verify the private `message-media` bucket and RLS policies in a non-production project before accepting uploads. The current browser upload creates private metadata; cross-member downloads require a signed-URL Edge Function and are intentionally not public.
