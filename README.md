# Your SIP Companion: Netlify + Gemini free tier

A public link that mentors can open without signing in to anything. The page is static; the AI runs in one Netlify Function that holds your Gemini API key, so the key never reaches the browser.

```
public/index.html                          the page: chat, cards, Without AI tab, Quality check tab
netlify/functions/companion/companion.mjs  /api/companion: calls Gemini and runs the rule check
netlify/functions/companion/core.mjs       prompts, rule check and the personal-details scrubber
netlify.toml                               tells Netlify where things are (no build step)
```

## 1. Get a free Gemini API key (about 2 minutes)

1. Go to Google AI Studio (aistudio.google.com) and sign in with a Google account.
2. Open **Get API key** and create a key. Let it create a new project if it asks.
3. **Don't add billing to that project.** Without billing, Google has nothing to charge: when the free limit is reached, requests fail and the page falls back to its pre-written replies.
4. Keep the key private. Don't paste it into chats, files or GitHub. It only goes into Netlify's settings (step 3).

## 2. Put this folder on GitHub (no terminal needed)

1. On GitHub, create a new repository, for example `your-sip-companion`. Don't use "zerodha" in the name.
2. On the empty repository page, choose **uploading an existing file**.
3. Drag in everything inside this folder (`netlify.toml`, `README.md`, `public`, `netlify`), then commit.

## 3. Deploy on Netlify (about 5 minutes)

1. In Netlify, choose **Add new site → Import an existing project → GitHub**, then pick the repository.
2. Leave the build settings as they are (`netlify.toml` sets them) and deploy.
3. Add the key: **Site configuration → Environment variables → Add a variable**.
   - Key: `GEMINI_API_KEY`
   - Value: your key from step 1
4. Redeploy so the function picks up the key: **Deploys → Trigger deploy → Deploy site**.
5. Optional: **Site configuration → Change site name**, for example `your-sip-companion`.

Check it: open `https://<your-site>.netlify.app/api/companion`. You should see `"configured":true`.

## 4. Run the quality check (switches AI replies on)

AI replies stay off until this prompt version passes the 38-case test set on this model.

1. Open your site, go to the **Quality check** tab and click **Run the 38 cases**.
2. Keep the tab open. It takes about 8 minutes because the free tier allows only a few requests a minute. If it hits the limit, it waits and retries.
3. Click **Copy results** and paste them into the chat with Claude.
4. Claude sends back a new `public/index.html` with the results built in. Replace that one file on GitHub (**Add file → Upload files**). Netlify redeploys by itself, and AI replies switch on.

## Optional settings (Netlify environment variables)

| Variable | Default | What it does |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | The Gemini model. Changing it switches AI replies off until the quality check is run again on the new model. |
| `GEMINI_THINKING_LEVEL` | `minimal` | How much the model thinks before answering. Lower is faster. If the model doesn't accept the setting, the function retries without it. |
| `MAX_REQUESTS_PER_10_MIN` | `150` | Rough cap per visitor, to stop one person using up the free quota. |

## Good to know

- **Personal details:** Google's free-tier terms say not to send personal information, and Google may use what's sent to improve its products. The page removes PAN, account numbers, phone numbers and email addresses before sending, the function removes them again, and the page asks people not to type them.
- **When the free limit is reached:** chat replies fall back to the pre-written answers with a note saying the AI is busy. Nothing breaks.
- **Not investment advice:** the rule check runs on the server and blocks any reply that names a fund or fund house, steers toward a type of fund, tells someone what to do with their investments, promises returns, uses pressure, repeats an ID number, or uses a number the page didn't work out.

### Command-line alternative to steps 2 and 3

```
npm install -g netlify-cli
netlify login
netlify deploy --prod          # run inside this folder; creates the site on first run
netlify env:set GEMINI_API_KEY "paste-your-key-here"
netlify deploy --prod          # redeploy so the function sees the key
```
