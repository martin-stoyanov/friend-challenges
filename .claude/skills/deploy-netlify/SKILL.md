---
name: deploy-netlify
description: Build and deploy the Friend Challenges app to Netlify (friend-challenges.netlify.app). Use when the user asks to deploy, ship, publish, or push the site live.
---

# Deploy to Netlify

Build the project and deploy it to Netlify (site: friend-challenges.netlify.app).

## Steps

1. Build the project:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && npm run build
```

2. Deploy to Netlify production:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && npx netlify-cli deploy --prod --dir=dist
```

3. Confirm the deploy is live by checking the output URL (should be https://friend-challenges.netlify.app).

## Notes
- The site is also auto-deployed on `git push` if the GitHub repo is linked in Netlify dashboard.
- The `netlify.toml` config handles build settings and SPA redirects.
- If your Netlify session expired, re-auth with: `npx netlify-cli logout && npx netlify-cli login`
