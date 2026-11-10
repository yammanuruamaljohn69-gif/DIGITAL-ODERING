DHABA LIVE ORDERING
===================
Customer scans table QR -> orders -> kitchen screen updates instantly (with a beep).

RUN ON YOUR PC (test)
  1. Install Node.js 18+ (nodejs.org)
  2. In this folder:  npm install   then   npm start
  3. Open http://localhost:3000/#kitchen   (PIN default 1234)

GO LIVE (so customers can scan from their own phones)
  Deploy this folder to Render.com / Railway.app (connect a GitHub repo):
   - Build command: npm install      Start command: npm start
   - Environment variable: KITCHEN_PIN = your secret PIN
   - Attach a small persistent disk and set DB_FILE=/data/orders.json
     (otherwise orders reset when the server restarts)
  Then open  https://YOUR-APP-URL/#qr , set number of tables, Print, stick on tables.

CHANGE MENU / PRICES: edit menu.json (id, cat, name, price) and redeploy.
Kitchen: open  /#kitchen  on a tablet, enter PIN once.
