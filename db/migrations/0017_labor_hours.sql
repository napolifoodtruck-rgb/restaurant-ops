-- Timecards from Square, for labor cost and when people worked (clock times are the
-- restaurant's local time), and sales by hour, for the day-and-hour view.
CREATE TABLE pos_timecards (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  team_member_id  text NOT NULL DEFAULT '',
  day             date NOT NULL,             -- the local date clocked in
  job_title       text,
  clock_in        timestamp NOT NULL,        -- local wall time
  clock_out       timestamp NOT NULL,
  hourly_wage     numeric,
  hours           numeric NOT NULL DEFAULT 0,
  labor_cost      numeric NOT NULL DEFAULT 0, -- hours × base wage, as Square figures it
  PRIMARY KEY (restaurant_id, team_member_id, clock_in)
);
CREATE INDEX pos_timecards_day ON pos_timecards (restaurant_id, day);

CREATE TABLE pos_sales_hourly (
  restaurant_id   uuid NOT NULL REFERENCES restaurants ON DELETE CASCADE,
  day             date NOT NULL,
  hour            smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  orders          integer NOT NULL DEFAULT 0,
  covers          integer NOT NULL DEFAULT 0,
  net_sales       numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, day, hour)
);
