# Labor ideas, done right (next)

The first labor rule compared every hour worked with that hour's sales. That flags the hour before
opening every day: at Napoli, 3:45–5pm has the front-of-house setup team and the whole kitchen on,
and almost no sales. It's turned off (`LABOR_IDEAS` in src/server/ideas.ts) until this is built.

Agreed with Napoli:

1. **Opening hours.** Read the location's business hours from Square (read-only), and learn them from
   hourly sales as a check. Both shown; either can be corrected.
2. **Jobs in groups**, guessed from the job title and confirmed in Settings (like kitchen/bar categories):
   - service: Server, Bar, Runner, Host
   - line: Pizza Maker, Expo (Expo is line)
   - prep: Prep Cook
   - support: Dishwasher
3. **Each judged on what it does:**
   - Service and line, only while open: sales per labor hour by weekday and hour. Leave the first hour
     after opening and the last before closing alone (setup, close).
   - Never suggest going below a minimum crew per role: learned from history (the fewest that role has
     had on during service). Napoli is fine with learned; allow an override later.
   - Prep against the prep lists: hours clocked by prep roles against the minutes the lists took
     (prep timing already measures it), e.g. "Tuesdays: 6 prep hours clocked, the lists take about 3½".
   - Before opening and after close are never judged against sales. Closing can come once there's a
     closing checklist to time against.
4. In dollars a month, at each role's real wage (pos_timecards.hourly_wage), not a house average.

Wait for a few more weeks of real timecards and prep check-offs before tuning thresholds.
