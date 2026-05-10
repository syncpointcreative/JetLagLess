# JetLagLess

A circadian playbook tailored to your flight, your sleep habits, and how your body
handles travel. Web app deployed on Vercel; same codebase runs on iOS/Android via
Expo.

## Web

```
npm install --legacy-peer-deps
npx expo export --platform web
```

Vercel handles this automatically on push to `main`. Set
`FLIGHTAWARE_API_KEY` in Vercel project settings for the flight-number lookup.

## Run on your phone (Expo Go)

1. Install **Expo Go** on your phone (App Store / Play Store).
2. Create a `.env` file with:
   ```
   EXPO_PUBLIC_API_BASE=https://YOUR-VERCEL-URL.vercel.app
   ```
   Replace with your live deployment URL — the native app calls the same
   serverless function for flight lookups.
3. Run:
   ```
   npm install --legacy-peer-deps
   npx expo start
   ```
4. Scan the QR code with the Expo Go app's scanner (iOS uses the system camera).

The first launch may take a minute to bundle. After that, edits hot-reload.
