# Noonan Warehouse Inventory: Setup Guide

This gets the app live at its own web address so crews can put it on their home screen, sign in once with their name and PIN, and start logging. Plan on about an hour. You do it once.

You'll need a computer, a credit card, and the `noonan-inventory.zip` file. Unzip it first so you have a folder called `noonan-inventory`.

## What it costs

| Service | What it does | Cost |
|---|---|---|
| Vercel Pro | Hosts the app | $20/month. The free Hobby plan is for personal use only, and Vercel's rules say business use needs Pro. |
| Neon (through Vercel) | Stores the stock list and activity | Free plan is plenty at your size |
| Anthropic | Reads photos and voice entries | Pay as you go. Roughly a cent or two per photo. Start with $20 of credit. |
| GitHub | Holds the code | Free |

## Step 1: Put the code on GitHub

1. Go to **github.com** and create a free account (or sign in).
2. Click **+** at the top right, then **New repository**.
3. Name it `noonan-inventory`, choose **Private**, and click **Create repository**.
4. On the next page, click the link that says **uploading an existing file**.
5. Open the `noonan-inventory` folder on your computer. Select everything inside it (the `api`, `lib` and `public` folders and all the files) and drag it onto the GitHub page. Don't drag the folder itself, drag what's inside it.
6. Wait for the uploads to finish, then click **Commit changes**.

Check: the repository page should show `api`, `lib`, `public`, `package.json` and `vercel.json` at the top level.

## Step 2: Put the app on Vercel

1. Go to **vercel.com** and click **Sign Up**. Choose **Continue with GitHub** and use the same GitHub account.
2. Pick the **Pro** plan when asked (see costs above).
3. Click **Add New**, then **Project**.
4. Find `noonan-inventory` in the list and click **Import**. If you don't see it, click the link to adjust GitHub permissions and give Vercel access to that repository.
5. Leave every setting as it is. Click **Deploy**.
6. When it finishes, you'll get a web address like `noonan-inventory.vercel.app`. That's your app. It won't work yet, because it has no database.

## Step 3: Add the database

1. In your Vercel project, click the **Storage** tab.
2. Click **Create Database** (or **Browse Marketplace**), choose **Neon**, and click **Continue**.
3. Pick the **Free** plan, choose the region closest to Michigan (**US East**), and name it `inventory`.
4. When it asks which project to connect, pick `noonan-inventory` and leave all environments checked. Click **Connect**.

Vercel adds the database connection to your project automatically. You don't copy anything.

## Step 4: Turn on photo and voice matching

1. Go to **console.anthropic.com** and create an account.
2. Go to **Billing** and add credit. $20 is a good start. You can turn on auto-reload so it never runs dry.
3. Go to **API Keys**, click **Create Key**, name it `noonan-inventory`, and copy the key. It starts with `sk-ant-`. You only see it once, so paste it somewhere safe for the next minute.
4. Back in Vercel, open your project, then **Settings**, then **Environment Variables**.
5. Add one:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** the key you just copied
   - Leave all environments checked. Click **Save**.

## Step 5: Restart the app so it picks up the changes

1. In Vercel, click the **Deployments** tab.
2. On the top deployment, click the **⋯** menu, then **Redeploy**, then **Redeploy** again.
3. Wait about a minute until it says **Ready**.

## Step 6: Create your manager account (do this right away)

1. Open your app's web address on your phone or computer.
2. You'll see **First-time setup**. Enter your name and pick a 4 to 6 digit PIN.
3. Do this as soon as the app is live. The first person to open it becomes the manager.

## Step 7: Load your stock

1. Tap **Stock**, then **Paste a list**.
2. Paste one item per line: `name, quantity, unit, reorder-at`. You can copy rows straight from a spreadsheet. For example:

   ```
   20A single-pole breaker, 48, ea, 12
   12/2 NM-B Romex, 1000, ft, 250
   Generac 24kW Guardian, 3, ea, 1
   ```

3. Pick **Livonia** or **Brighton** and tap **Add items**. Do it again for the other warehouse.

## Step 8: Add your crew

1. Tap **Me**, then **Manage crew and PINs**, then **Add person**.
2. Enter their name the way you want it on the sign-in screen, give them a PIN, and pick **Crew** or **Manager**.
   - **Crew** can log material and add or edit items.
   - **Managers** can also paste lists, delete items, undo anyone's entry, and manage the crew.
3. Give each person their PIN in person or by text.

To lock someone out (for example, they leave the company), open their name and uncheck **Can sign in**. That signs them out on every phone right away.

## Step 9: Put it on each phone

Text the web address to each crew member. Then:

- **iPhone:** Open it in **Safari**, tap **Share**, then **Add to Home Screen**. Leave **Open as Web App** on.
- **Android:** Open it in **Chrome**, tap **⋮**, then **Add to Home screen** or **Install app**.

They open the Bolt icon, tap their name, enter their PIN once, and they stay signed in after that.

## If something goes wrong

| What you see | What to do |
|---|---|
| "The database isn't connected yet" | Redo step 3, then step 5. |
| "Photo and voice matching isn't set up yet" | Redo step 4, then step 5. |
| "The Anthropic key isn't valid" | Make a new key in step 4, replace the old value in Vercel, then step 5. |
| "The Anthropic account is out of credit" | Add credit at console.anthropic.com under Billing. |
| Someone is locked out after wrong PINs | Wait 15 minutes, or a manager sets them a new PIN under Manage crew. |
| "Tap to talk" doesn't appear | That phone doesn't support it in the app. Use the mic on the keyboard instead. |

## For a tech person

- Static front end in `public/`, one serverless function at `api/[route].js`, shared logic in `lib/core.js`.
- Postgres through `DATABASE_URL` (or `POSTGRES_URL`). Tables are created automatically on first request.
- Stock changes run in one database transaction per entry, so two crews logging at once can't overwrite each other.
- Optional settings: `APP_SECRET` (signs sign-in tokens; otherwise derived from the database URL) and `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`).
- Local test: `npm install`, then `DATABASE_URL=postgres://... node dev-server.js`. Add `MOCK_CLAUDE=1` to test without an Anthropic key.
