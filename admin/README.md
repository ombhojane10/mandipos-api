# MandiPlus POS Admin

The admin portal for the Mandi POS app: approve new shops, see each shop's figures (the same
sums the app shows), and look up any customer's full history.

- Talks to `mandipos-api`'s `/v1/admin/*` routes: directly in production (`VITE_API_URL`, and the
  API's `ADMIN_ORIGINS` lets this site's origin in), through Vite's `/api` proxy locally.
- Sign-in is an OTP to a number on the API's `ADMIN_PHONES` env var (Render). Add or remove a
  number there; it takes effect on the next request.

```
npm install
npm run dev            # http://localhost:5173, API at POS_API (default http://localhost:3032)
npm run build
```

Deploys on Render as a static site (`mandipos-admin`, root directory `admin/` of this repo): a push to
`main` that touches `admin/` goes live.
