# Testing

`npm run build` performs TypeScript checking and a production Vite build. Before production, add browser tests for auth, membership isolation, realtime reconnect, duplicate retries, offline queue recovery, and message pagination. Run Supabase SQL policy tests against a disposable project.

Manually verify messaging with two authenticated accounts: send a text in each direction, reload the conversation, and confirm both messages persist. Turn off the network before sending a text and confirm it appears as queued on this device, then reconnect and confirm it changes to a delivered message. If history loading or sending fails, confirm the conversation displays the underlying error and a retry action where appropriate.
