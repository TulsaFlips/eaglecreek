# Eagle Creek for phone, iPad and Chrome

The job-site side of Eagle Creek, in the Mac app's colours and layout: projects, progress
photos, daily logs, punch lists, schedules, documents and the calendar. It uses the same
Supabase account as the Mac app, so anything done on the phone shows up on the Mac at its next
sync (every few minutes, or **Sync Now**), and the other way round.

## What it does

- **Projects:** grouped like the Mac's sidebar (Active Projects, Pipeline, Rentals, Closed), with
  status colours, address and directions, schedule progress, late tasks and open punch items.
  Inside a project, the Mac's sections: Overview, Budget (Budget, Selections, Subs & POs),
  Schedule (Schedule, Daily Logs, Punch List) and Files (Photos, Documents). Each section
  remembers the page you were last on.
- **Budget:** every line by category with its quantity and cost, what's been billed against it in
  the books, % done and the typed actual, with the contingency, total, per square foot, billed to
  date and budget left worked out exactly as the Mac does. Lines billed over budget are flagged.
  Tap a line for what's been paid and the bills behind it. The budget itself is changed on the Mac.
- **Selections:** the finish schedule: every finish and fixture by category, with product, color,
  quantity, cost, supplier and status (TBD, GC Choice, Locked, Ordered, Installed, N/A). Order-by
  dates come from the schedule (the task it's needed for less the lead time) or a firm date, and
  items late or due to order this week are called out. On client jobs, allowances and overages
  at the job's markup. Add, change and delete selections, start from the standard list or one of
  your finish packages. Marking one Ordered stamps today's order date, as on the Mac.
- **Subs & POs:** each subcontract and purchase order with what's committed, billed and left, and
  the retainage held.
- **Photos:** take or pick photos straight into a project's Progress Photos, or into a daily log.
  They're resized on the phone (2400 px) so they upload fast from the site. Swipe between
  photos; delete one taken by mistake.
- **Daily Logs:** today's log in one tap, with the last log's crews carried over. Same sections
  as the Mac (Weather, Crews on Site, Work Performed, Deliveries and Inspections, Problems,
  Delays and Safety, Notes), weather filled in for the project's city, photos attached. Saves
  as you type.
- **Punch List:** add items; the square marks them done, as on the Mac. Ready to check is in each
  item's details.
- **Schedule:** the Mac's dates (workdays, US holidays, tasks that wait on others). Set Not
  Started, Working On It, Stuck or Done, percent complete and notes. The **Schedule** tab shows
  the next two weeks across every active project, stuck and late work first.
- **Documents:** every file on a project by type. Share / Save keeps a copy.
- **Plan reader and takeoffs:** any PDF opens as a drawing set (the **Plans** button on a
  project's overview goes straight to its Plans & Specs). See below.
- **Calendar:** day and week views of your events and active projects' tasks. Add, edit and
  delete events, with the Mac's options (repeat, reminder, project, who it's with, delete only
  one repeat).
- **Contacts:** every trade, supplier, crew member, customer and lender. Call, text or email in a
  tap; see their projects, open tasks and punch items, subcontracts and POs, bills and invoices
  (what you've paid them this year, what's owed, lien waivers still needed), and every file tied
  to them: W-9s, insurance certificates, quotes, invoices, waivers and subcontract paperwork,
  matched the same way as on the Mac. Expired insurance and missing W-9s are flagged. Add or edit
  contacts and add files to them (a W-9 marks it on file; an insurance certificate can update the
  expiry date). Bills, invoices and subcontracts are view-only here.
- **Receipts:** the receipt button on Projects sends a photo to Books › Receipts on the Mac.
- **Appearance:** Light (the default, like the Mac), Dark or Match Device, in Settings.
- **Works offline.** Everything is saved on the device first and uploads when there's signal.

Bills, invoices, the budget lines themselves, contracts, QuickBooks and the rest are edited on
the Mac.

## Plan reader

- **Move around:** pinch to zoom, drag to move, double-tap to zoom in (again to zoom out).
  On a computer, pinch the trackpad or hold Ctrl while scrolling. Whatever is on screen is redrawn
  sharp, so small dimensions stay readable. **Fit** shows the whole sheet; the arrows (or the
  sheet name) change sheets.
- **Set the scale** for each sheet (**Scale** at the bottom), once:
  - **Measure a Known Dimension** (most reliable): tap both ends of a dimension printed on the
    drawing and type its length.
  - Or pick the **printed scale** (1/4" = 1'-0", 1" = 20' and so on). This is only right when
    the PDF is full size, not a half-size 11×17 set.
  - Either can be used for every sheet in the set.
- **Measure:** **Length** (two taps), **Run** (tap point to point for walls, trim, pipe; Done to
  finish), **Area** (tap each corner; tap the first corner or Done to close; shows sq ft and the
  distance around), **Count** (tap each outlet, fixture or post). A magnifier shows under your
  finger while you place a point, and the **Straight** button keeps lines level, plumb or at 45°.
- **Change one:** tap it in Move to name it ("Kitchen floor"), change its colour, drag its white
  dots, or delete it.
- **The list** (top right) totals every sheet and copies everything as text for an estimate or
  a message.
- Scales and measurements sync between your phones and iPads. The Mac app doesn't show them
  yet; they're saved so it can later.

## Put it online with GitHub Pages (one time, about 10 minutes, iPad or computer)

All the app's files sit in one folder with no subfolders, so it uploads from an iPad too.

1. Unzip `EagleCreek-Web.zip`. On an iPad, tap it in the Files app; on a Mac, double-click it.
2. Sign in at **github.com** (in Safari on an iPad), tap **+** (top right) → **New repository**.
   Name it `eaglecreek`, choose **Public**, tap **Create repository**.
3. Tap **uploading an existing file**, then **choose your files**. In the `eaglecreek-web`
   folder, tap **Select**, then select all the files (or drag them all in on a Mac).
   Tap **Commit changes**.
4. Go to **Settings → Pages**. Under **Branch**, pick **main** and **/ (root)**, tap **Save**.
5. Wait a minute or two and refresh. Your address appears at the top:
   `https://YOUR-USERNAME.github.io/eaglecreek/`

To update later: open the repository, **Add file → Upload files**, add all the files from the
new `eaglecreek-web` folder and commit. Phones pick up the new version the next time the app
is opened (never while you're typing).

Public only means the app's code can be seen. Your data never goes to GitHub: the page talks
straight to your Supabase project, and only your email and password can open it.

## Each phone or iPad

1. **iPhone / iPad:** open your address in Safari, tap **Share → Add to Home Screen**, then open
   Eagle Creek from the Home Screen. Do this before signing in: the Home Screen app keeps its
   own sign-in, separate from Safari.
   **Android:** open it in Chrome, then ⋮ → **Add to Home screen** (or **Install app**).
   **Computer:** in Chrome, the install icon in the address bar.
2. Sign in with the Supabase project URL and anon (or publishable) key, and the email and
   password you sync with on the Mac. The URL and key are in the Mac app under Settings →
   Cloud Sync, or on supabase.com under your project's **Connect** button (or Project Settings →
   API Keys). Never use the secret or service_role key.
3. Once one device is set up, **Settings → Set Up Another Device** makes a link with the URL and
   key. On the next device, paste it into the first box on the sign-in screen; both boxes fill in.

The Mac app needs Cloud Sync turned on with the same account. If it isn't yet, set it up in the
Mac app's Settings → Cloud Sync and run `supabase/setup.sql` in the Supabase SQL Editor.

## Good to know

- Edits follow the Mac's rule: the newest edit wins. If the same punch item is changed on the
  phone and the Mac between syncs, the later change is kept.
- Selections are saved inside the project, which the Mac also edits. Each change made here is
  kept as a step until it reaches Supabase; if the project changed on the Mac in the meantime
  (even while the phone had no signal), the step is made again on the Mac's newer copy, so
  neither edit is lost. The one case to avoid: changing the same project on the Mac in the few
  minutes before it syncs, while selections are changed here. Then the Mac keeps both versions
  (one as a conflict copy), as it does between two Macs.
- The pill at the top shows sync. Tap it to sync now (or, if there's a problem, to see why).
  Photos waiting to upload say so on the photo.
- Receipts wait in Books › Receipts on the Mac. **Enter as Expense** there reads the store,
  date and total.
- Reminders on events come from the Mac app's notifications.
- **Settings → Free Up Space** removes downloaded copies of photos and documents; they download
  again when opened. Signing out removes everything on that device, and warns first if
  anything hasn't uploaded yet.
- Files over 50 MB can't sync (Supabase's limit), same as on the Mac.
- PDFs are shown with Mozilla's pdf.js (`pdf.min.js` and `pdf.worker.min.js`, Apache 2.0 licence; see `PDFJS-LICENSE.txt`).
