# Lingore Real Voice MVP

This is the real-backend direction for the Lingore design supplied in the 21-page PDF.

Implemented in this starter:
- Google authentication through Supabase Auth
- Persistent profiles
- Language + level onboarding
- Atomic database matching queue with reciprocal language matching
- Immediate Realtime notification to the waiting user
- Private realtime signaling channels
- WebRTC microphone/audio connection
- Mute + hangup
- Database-backed conversation totals
- Database-backed streak calculation
- Block/report database foundations
- RLS policies

The PDF's design has 21 screens, including onboarding, home, matching, connected/call, post-call, profile, streak, explore, settings, help, language selection, matching preferences, privacy, block/report, microphone permission, connection failure, and account management. This code focuses first on the core product loop: authenticate -> profile -> match -> real voice call -> stats/streak. The remaining screens can be layered onto the same backend.

## Setup

1. Create a Supabase project.
2. Open SQL Editor and run `supabase/schema.sql`.
3. Enable Google provider in Supabase Auth and configure the Google OAuth client.
4. Copy the project URL and publishable key into `.env`.
5. `npm install`
6. `npm run dev`

## Critical production work before public launch

### TURN
The example includes a public STUN server. WebRTC will not reliably connect every pair of users with STUN alone. Add a production TURN service and credentials to `ICE_SERVERS`.

### Realtime authorization
The call and matching channels should be private. Configure Realtime authorization so only authenticated participants can subscribe/broadcast to the relevant topics.

### Matching
The SQL function uses row locking to avoid two users claiming the same queue entry. For large scale, move matching to a server-side worker/Edge Function and add rate limits.

### Safety
A stranger voice app needs block/report, abuse review, rate limits, duplicate-account controls, age/eligibility handling, and emergency handling before public launch.

### Account deletion
The UI should call a server-side/admin deletion workflow; do not expose privileged Supabase secrets in browser code.

### Stats
Only the server/database should be authoritative for streaks and conversation time. Never trust client-provided totals.

## Architecture

Browser
  -> Supabase Auth (Google)
  -> Supabase Postgres + RLS (profiles, queue, calls, reports)
  -> Supabase Realtime (private signaling)
  -> WebRTC audio (peer-to-peer; TURN required for reliability)

Supabase publishable keys may be used in browser apps with correct RLS. Never put a secret/service key in frontend code.
