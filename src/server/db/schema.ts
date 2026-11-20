// Azure SQL schema (TD-AZURE §3): an append-only list of migrations, each a list of T-SQL batches; the version is kept
// in `schema_version`. Migration 1 is where the 8 SQLite migrations (sqlite-migrations.ts) ended, plus `job_lease`.
import type { Db } from './database.ts';

/** Text compares and sorts byte by byte, case-sensitive, as SQLite's BINARY did. */
export const BIN = 'Latin1_General_100_BIN2';
/** E-mail addresses: case-insensitive, as SQLite's NOCASE was. */
export const CI = 'Latin1_General_100_CI_AS';

const t = (n: number | 'MAX') => `NVARCHAR(${n}) COLLATE ${BIN}`;
const email = `NVARCHAR(320) COLLATE ${CI}`;
const NOW_MS = "DATEDIFF_BIG(MILLISECOND, '19700101', SYSUTCDATETIME())";

/** Every table, children before parents: the order to empty them (tests, import); reversed, the order to fill them. */
export const TABLES = [
  'deleted_sources',
  'trade_watches',
  'push_devices',
  'bot_events',
  'bot_trades',
  'bots',
  'trade_log',
  'news_ai_scores',
  'news_coins',
  'news',
  'sources',
  'daily_sentiment',
  'calendar_raw',
  'calendar_custom',
  'earn_results',
  'job_state',
  'job_lease',
  'watch_list_items',
  'watch_lists',
  'watchlist',
  'cost_basis',
  'paper_trades',
  'paper_orders',
  'paper_positions',
  'paper_accounts',
  'exchange_accounts',
  'market_cache',
  'settings',
  'user_settings',
  'user_keys',
  'ai_daily_sentiment',
  'user_tokens',
  'sessions',
  'passkeys',
  'day_summaries',
  'account_requests',
  'econ_releases',
  'econ_indicators',
  'users',
] as const;

/** Tables whose `id` is an IDENTITY column. */
export const IDENTITY_TABLES = new Set(['users', 'calendar_custom', 'exchange_accounts', 'passkeys', 'account_requests', 'trade_log', 'watch_lists', 'bots', 'bot_trades', 'bot_events', 'paper_positions', 'paper_orders', 'paper_trades', 'push_devices', 'trade_watches']);

/** The admin (id 1) every new database starts with, without e-mail or password (FD-USERS §3). */
export const SEED_ADMIN = `SET IDENTITY_INSERT users ON;
INSERT INTO users (id, email, name, role, email_verified_at, created_at) VALUES (1, NULL, N'', N'admin', ${NOW_MS}, ${NOW_MS});
SET IDENTITY_INSERT users OFF`;

export const MIGRATIONS: string[][] = [
  // 1 — FD-AZURE: the SQLite schema at version 8, in T-SQL; job_lease (TD-AZURE §6).
  [
    `CREATE TABLE settings (
      [key] ${t(100)} NOT NULL PRIMARY KEY,
      value ${t('MAX')} NOT NULL
    );
    CREATE TABLE sources (
      id ${t(200)} NOT NULL PRIMARY KEY,
      name ${t('MAX')} NOT NULL,
      url ${t('MAX')} NOT NULL,
      url_hash AS CAST(HASHBYTES('SHA2_256', url) AS BINARY(32)) PERSISTED,
      category ${t(20)} NOT NULL CHECK (category IN (N'crypto', N'macro', N'geopolitics', N'stocks')),
      enabled INT NOT NULL DEFAULT 1,
      weight FLOAT NOT NULL DEFAULT 1,
      builtin INT NOT NULL DEFAULT 0,
      etag ${t('MAX')} NULL,
      last_modified ${t('MAX')} NULL,
      last_attempt_at BIGINT NULL,
      last_success_at BIGINT NULL,
      last_new_item_at BIGINT NULL,
      last_error ${t('MAX')} NULL,
      failures INT NOT NULL DEFAULT 0,
      next_fetch_at BIGINT NOT NULL DEFAULT 0,
      item_count INT NOT NULL DEFAULT 0,
      auto ${t(200)} NULL
    );
    CREATE UNIQUE INDEX sources_url ON sources(url_hash);`,
    `CREATE TABLE news (
      id ${t(64)} NOT NULL PRIMARY KEY,
      source_id ${t(200)} NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      guid ${t('MAX')} NULL,
      url ${t('MAX')} NULL,
      canonical_url ${t('MAX')} NULL,
      canonical_hash AS CAST(HASHBYTES('SHA2_256', canonical_url) AS BINARY(32)) PERSISTED,
      title ${t('MAX')} NOT NULL,
      summary ${t('MAX')} NOT NULL DEFAULT N'',
      published_at BIGINT NOT NULL,
      fetched_at BIGINT NOT NULL,
      category ${t('MAX')} NOT NULL,
      relevance FLOAT NOT NULL,
      impact FLOAT NOT NULL,
      flags ${t('MAX')} NOT NULL DEFAULT N'[]',
      cluster_id ${t(64)} NOT NULL,
      sentiment FLOAT NULL,
      sentiment_label ${t('MAX')} NULL,
      sentiment_engine ${t(100)} NULL,
      sentiment_meta ${t('MAX')} NULL,
      scored_at BIGINT NULL,
      sentiment_impact FLOAT NULL
    );
    CREATE INDEX news_published ON news(published_at);
    CREATE INDEX news_cluster ON news(cluster_id);
    CREATE INDEX news_canonical ON news(canonical_hash);
    CREATE INDEX news_unscored ON news(sentiment_engine, published_at);
    CREATE INDEX news_source ON news(source_id, published_at);
    CREATE TABLE news_coins (
      news_id ${t(64)} NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      coin ${t(64)} NOT NULL,
      PRIMARY KEY (news_id, coin)
    );
    CREATE INDEX news_coins_coin ON news_coins(coin);`,
    `CREATE TABLE daily_sentiment (
      day ${t(16)} NOT NULL,
      tz ${t(64)} NOT NULL,
      value FLOAT NOT NULL,
      raw FLOAT NOT NULL,
      confidence ${t('MAX')} NOT NULL,
      counts ${t('MAX')} NOT NULL,
      breakdown ${t('MAX')} NOT NULL,
      drivers ${t('MAX')} NOT NULL,
      computed_at BIGINT NOT NULL,
      final INT NOT NULL DEFAULT 0,
      PRIMARY KEY (day, tz)
    );
    CREATE TABLE calendar_raw (
      source ${t(16)} NOT NULL,
      ext_id ${t(200)} NOT NULL,
      title ${t('MAX')} NOT NULL,
      currency ${t('MAX')} NOT NULL,
      country ${t('MAX')} NULL,
      ts BIGINT NOT NULL,
      all_day INT NOT NULL DEFAULT 0,
      impact ${t('MAX')} NOT NULL,
      forecast ${t('MAX')} NULL,
      previous ${t('MAX')} NULL,
      actual ${t('MAX')} NULL,
      unit ${t('MAX')} NULL,
      scale ${t('MAX')} NULL,
      period ${t('MAX')} NULL,
      fetched_at BIGINT NOT NULL,
      PRIMARY KEY (source, ext_id)
    );
    CREATE INDEX calendar_raw_ts ON calendar_raw(ts);
    CREATE TABLE job_state (
      name ${t(100)} NOT NULL PRIMARY KEY,
      last_start BIGINT NULL,
      last_end BIGINT NULL,
      last_ok BIGINT NULL,
      last_error ${t('MAX')} NULL,
      runs INT NOT NULL DEFAULT 0,
      data ${t('MAX')} NULL
    );
    CREATE TABLE job_lease (
      name ${t(50)} NOT NULL PRIMARY KEY,
      owner ${t(100)} NOT NULL,
      host ${t(200)} NOT NULL,
      expires_at BIGINT NOT NULL
    );
    CREATE TABLE market_cache (
      [key] ${t(300)} NOT NULL PRIMARY KEY,
      value ${t('MAX')} NOT NULL,
      fetched_at BIGINT NOT NULL
    );`,
    `CREATE TABLE users (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      email ${email} NULL,
      name ${t('MAX')} NOT NULL DEFAULT N'',
      password_hash ${t('MAX')} NULL,
      role ${t(10)} NOT NULL DEFAULT N'user' CHECK (role IN (N'admin', N'user')),
      email_verified_at BIGINT NULL,
      created_at BIGINT NOT NULL,
      last_login_at BIGINT NULL,
      disabled_at BIGINT NULL,
      totp_secret ${t('MAX')} NULL,
      totp_confirmed_at BIGINT NULL,
      totp_last_step BIGINT NOT NULL DEFAULT 0,
      recovery_codes ${t('MAX')} NULL,
      passkey_user_handle VARBINARY(MAX) NULL
    );
    CREATE UNIQUE INDEX users_email ON users(email) WHERE email IS NOT NULL;
    CREATE TABLE user_tokens (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind ${t(16)} NOT NULL CHECK (kind IN (N'verify', N'reset', N'activate')),
      token_hash ${t(128)} NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
    CREATE TABLE sessions (
      id_hash ${t(128)} NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind ${t(16)} NOT NULL CHECK (kind IN (N'full', N'pending')),
      created_at BIGINT NOT NULL,
      last_seen_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      ip ${t('MAX')} NULL,
      user_agent ${t('MAX')} NULL
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE passkeys (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id ${t('MAX')} NOT NULL,
      credential_hash AS CAST(HASHBYTES('SHA2_256', credential_id) AS BINARY(32)) PERSISTED,
      public_key VARBINARY(MAX) NOT NULL,
      counter BIGINT NOT NULL DEFAULT 0,
      transports ${t('MAX')} NULL,
      device_type ${t('MAX')} NULL,
      backed_up INT NOT NULL DEFAULT 0,
      name ${t('MAX')} NOT NULL,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT NULL
    );
    CREATE UNIQUE INDEX passkeys_credential ON passkeys(credential_hash);
    CREATE INDEX passkeys_user ON passkeys(user_id);
    CREATE TABLE user_settings (
      user_id INT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      value ${t('MAX')} NOT NULL
    );
    CREATE TABLE account_requests (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      email ${email} NOT NULL UNIQUE,
      name ${t('MAX')} NOT NULL,
      created_at BIGINT NOT NULL
    );`,
    `CREATE TABLE watchlist (
      user_id INT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE,
      coin ${t(64)} NOT NULL,
      quote ${t('MAX')} NOT NULL DEFAULT N'USDT',
      position INT NOT NULL DEFAULT 0,
      aliases ${t('MAX')} NOT NULL DEFAULT N'[]',
      added_at BIGINT NOT NULL,
      kind ${t('MAX')} NOT NULL DEFAULT N'crypto',
      name ${t('MAX')} NULL,
      exchange ${t('MAX')} NULL,
      PRIMARY KEY (user_id, coin)
    );
    CREATE TABLE exchange_accounts (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      exchange ${t('MAX')} NOT NULL,
      label ${t('MAX')} NOT NULL,
      api_key ${t('MAX')} NOT NULL,
      secret ${t('MAX')} NOT NULL,
      password ${t('MAX')} NULL,
      key_hint ${t('MAX')} NOT NULL,
      created_at BIGINT NOT NULL,
      last_ok_at BIGINT NULL,
      last_error ${t('MAX')} NULL,
      permissions ${t('MAX')} NULL,
      credentials ${t('MAX')} NULL,
      env ${t('MAX')} NOT NULL DEFAULT N'live',
      user_id INT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX exchange_accounts_user ON exchange_accounts(user_id);
    CREATE TABLE cost_basis (
      account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
      asset ${t(64)} NOT NULL,
      avg_price FLOAT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (account_id, asset)
    );
    CREATE TABLE calendar_custom (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      title ${t('MAX')} NOT NULL,
      ts BIGINT NOT NULL,
      all_day INT NOT NULL DEFAULT 0,
      impact ${t('MAX')} NOT NULL,
      currency ${t('MAX')} NOT NULL DEFAULT N'CRYPTO',
      note ${t('MAX')} NOT NULL DEFAULT N'',
      created_at BIGINT NOT NULL,
      user_id INT NOT NULL DEFAULT 1 REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX calendar_custom_ts ON calendar_custom(ts);
    CREATE INDEX calendar_custom_user ON calendar_custom(user_id, ts);
    CREATE TABLE day_summaries (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day ${t(16)} NOT NULL,
      tz ${t(64)} NOT NULL,
      created_at BIGINT NOT NULL,
      model ${t('MAX')} NOT NULL,
      content ${t('MAX')} NOT NULL,
      charts ${t('MAX')} NOT NULL,
      PRIMARY KEY (user_id, day)
    );`,
    `CREATE TABLE econ_indicators (
      [key] ${t(200)} NOT NULL PRIMARY KEY,
      country ${t(16)} NOT NULL,
      name ${t('MAX')} NOT NULL,
      category ${t('MAX')} NULL,
      unit ${t('MAX')} NULL,
      scale ${t('MAX')} NULL,
      currency ${t('MAX')} NULL,
      importance INT NOT NULL DEFAULT -1,
      source ${t('MAX')} NULL,
      source_url ${t('MAX')} NULL,
      comment ${t('MAX')} NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX econ_indicators_country ON econ_indicators(country);
    CREATE TABLE econ_releases (
      id ${t(100)} NOT NULL PRIMARY KEY,
      [key] ${t(200)} NOT NULL REFERENCES econ_indicators([key]) ON DELETE CASCADE,
      ts BIGINT NOT NULL,
      period ${t('MAX')} NULL,
      reference_date BIGINT NULL,
      actual FLOAT NULL,
      previous FLOAT NULL,
      forecast FLOAT NULL,
      fetched_at BIGINT NOT NULL
    );
    CREATE INDEX econ_releases_key ON econ_releases([key], ts);
    CREATE INDEX econ_releases_ts ON econ_releases(ts);`,
    `CREATE TABLE mcp_clients (
      client_id ${t(200)} NOT NULL PRIMARY KEY,
      client_name ${t('MAX')} NOT NULL,
      redirect_uris ${t('MAX')} NOT NULL,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT NULL
    );
    CREATE TABLE mcp_grants (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id ${t('MAX')} NOT NULL,
      client_name ${t('MAX')} NOT NULL,
      client_host ${t('MAX')} NOT NULL,
      redirect_host ${t('MAX')} NOT NULL,
      scope ${t('MAX')} NOT NULL,
      resource ${t('MAX')} NOT NULL,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT NULL,
      revoked_at BIGINT NULL
    );
    CREATE INDEX mcp_grants_user ON mcp_grants(user_id);
    CREATE TABLE mcp_codes (
      hash ${t(128)} NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      client_id ${t('MAX')} NOT NULL,
      client_name ${t('MAX')} NOT NULL,
      client_host ${t('MAX')} NOT NULL,
      redirect_uri ${t('MAX')} NOT NULL,
      redirect_host ${t('MAX')} NOT NULL,
      code_challenge ${t('MAX')} NOT NULL,
      scope ${t('MAX')} NOT NULL,
      resource ${t('MAX')} NOT NULL,
      expires_at BIGINT NOT NULL,
      used_at BIGINT NULL,
      grant_id INT NULL
    );
    CREATE TABLE mcp_tokens (
      hash ${t(128)} NOT NULL PRIMARY KEY,
      grant_id INT NOT NULL REFERENCES mcp_grants(id) ON DELETE CASCADE,
      kind ${t(16)} NOT NULL CHECK (kind IN (N'access', N'refresh')),
      expires_at BIGINT NOT NULL,
      rotated_at BIGINT NULL
    );
    CREATE INDEX mcp_tokens_grant ON mcp_tokens(grant_id);`,
    SEED_ADMIN,
  ],
  // 2 — FD-MCPREMOVE: the AI connector is gone; its tables with it (children first).
  ['DROP TABLE IF EXISTS mcp_tokens; DROP TABLE IF EXISTS mcp_codes; DROP TABLE IF EXISTS mcp_grants; DROP TABLE IF EXISTS mcp_clients;'],
  // 3 — FD-AIKEYS, FD-TDKEYS: each user's own keys (AI providers, Twelve Data), the news scores their AI gave and the
  // daily index made from them.
  [
    `CREATE TABLE user_keys (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name ${t(20)} NOT NULL,
      secret ${t('MAX')} NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, name)
    );
    CREATE TABLE news_ai_scores (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      news_id ${t(64)} NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      score FLOAT NULL,
      label ${t(20)} NULL,
      engine ${t(100)} NOT NULL,
      impact FLOAT NULL,
      scored_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, news_id)
    );
    CREATE INDEX news_ai_scores_news ON news_ai_scores(news_id);
    CREATE TABLE ai_daily_sentiment (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day ${t(16)} NOT NULL,
      tz ${t(64)} NOT NULL,
      value FLOAT NOT NULL,
      raw FLOAT NOT NULL,
      confidence ${t('MAX')} NOT NULL,
      counts ${t('MAX')} NOT NULL,
      breakdown ${t('MAX')} NOT NULL,
      drivers ${t('MAX')} NOT NULL,
      computed_at BIGINT NOT NULL,
      final INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, tz)
    );`,
  ],
  // 4 — FD-2FA: the new authenticator's secret while the user changes it (the old one works until it is confirmed).
  [`ALTER TABLE users ADD totp_next_secret ${t('MAX')} NULL;`],
  // 5 — FD-TRADING: trading switched on per account, and the journal of what Sentiq sent (kept after the exchange
  // account goes, with the user; one row per idempotency key).
  [
    `ALTER TABLE exchange_accounts ADD trading_enabled_at BIGINT NULL, trading_markets ${t(40)} NULL;`,
    `CREATE TABLE trade_log (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id INT NULL,
      exchange ${t(40)} NOT NULL,
      env ${t(20)} NOT NULL,
      account_label ${t(200)} NOT NULL,
      idem_key ${t(64)} NULL,
      action ${t(16)} NOT NULL,
      market ${t(16)} NULL,
      symbol ${t(80)} NULL,
      side ${t(8)} NULL,
      kind ${t(16)} NULL,
      amount FLOAT NULL,
      price FLOAT NULL,
      trigger_price FLOAT NULL,
      leverage FLOAT NULL,
      status ${t(16)} NOT NULL,
      order_id ${t(120)} NULL,
      message ${t(500)} NULL,
      detail ${t('MAX')} NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX trade_log_idem ON trade_log(user_id, idem_key) WHERE idem_key IS NOT NULL;
    CREATE INDEX trade_log_user ON trade_log(user_id, created_at);`,
  ],
  // 6 — FD-WHYPLAIN §3: the user's AI says in a sentence why it gave the score (null for scores given before).
  [`ALTER TABLE news_ai_scores ADD reason ${t(400)} NULL;`],
  // 7 — FD-MULTICAT: a source covering several categories ("crypto,stocks,macro,geopolitics"); null for one (`category`).
  [`ALTER TABLE sources ADD categories ${t(100)} NULL;`],
  // 8 — FD-HTMLFEED: a source read from a site's page: how (null: its address is a feed), and the address then read.
  [`ALTER TABLE sources ADD read_as ${t(20)} NULL, read_url ${t('MAX')} NULL;`],
  // 9 — FD-WATCHLISTS: named lists of symbols; `watchlist` stays the register of the symbols in any of them (their pair,
  // aliases, name). Each user's favourites so far become their list "Favorite", in the same order.
  [
    `CREATE TABLE watch_lists (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name ${t(40)} NOT NULL,
      position INT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX watch_lists_user ON watch_lists(user_id, position);
    CREATE TABLE watch_list_items (
      list_id INT NOT NULL REFERENCES watch_lists(id) ON DELETE CASCADE,
      coin ${t(64)} NOT NULL,
      position INT NOT NULL DEFAULT 0,
      added_at BIGINT NOT NULL,
      PRIMARY KEY (list_id, coin)
    );`,
    `INSERT INTO watch_lists(user_id, name, position, created_at) SELECT DISTINCT user_id, N'Favorite', 0, ${NOW_MS} FROM watchlist;
    INSERT INTO watch_list_items(list_id, coin, position, added_at) SELECT l.id, w.coin, w.position, w.added_at FROM watchlist w JOIN watch_lists l ON l.user_id = w.user_id;`,
  ],
  // 10 — FD-BOT: the trading bots (the user's settings, the engine's state), their closed trades and their journal. No
  // key to the account: a deleted account is found by the engine (a second cascade path from users is refused).
  [
    `CREATE TABLE bots (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name ${t(60)} NOT NULL,
      strategy ${t(16)} NOT NULL,
      execution ${t(8)} NOT NULL,
      account_id INT NULL,
      market ${t(8)} NOT NULL,
      area ${t(8)} NOT NULL,
      symbols ${t('MAX')} NOT NULL,
      tf ${t(8)} NOT NULL,
      config ${t('MAX')} NOT NULL,
      status ${t(12)} NOT NULL,
      status_reason ${t(600)} NULL,
      command ${t('MAX')} NULL,
      state ${t('MAX')} NOT NULL,
      starts_at BIGINT NOT NULL,
      ends_at BIGINT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      ran_at BIGINT NULL
    );
    CREATE INDEX bots_user ON bots(user_id, created_at);
    CREATE INDEX bots_status ON bots(status);
    CREATE TABLE bot_trades (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      bot_id INT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      symbol ${t(40)} NOT NULL,
      side ${t(8)} NOT NULL,
      qty FLOAT NOT NULL,
      entry FLOAT NOT NULL,
      [exit] FLOAT NOT NULL,
      pnl FLOAT NOT NULL,
      fees FLOAT NOT NULL,
      opened_at BIGINT NOT NULL,
      closed_at BIGINT NOT NULL,
      reason ${t(16)} NOT NULL
    );
    CREATE INDEX bot_trades_bot ON bot_trades(bot_id, closed_at);
    CREATE TABLE bot_events (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      bot_id INT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      at BIGINT NOT NULL,
      kind ${t(12)} NOT NULL,
      symbol ${t(40)} NULL,
      message ${t(600)} NOT NULL,
      detail ${t('MAX')} NULL
    );
    CREATE INDEX bot_events_bot ON bot_events(bot_id, id);`,
  ],
  // 11 — FD-TRADES: a bot's trade keeps the account and the market it was made on (null account: Simulare) and its
  // levels, for the account's trade history. Old rows: the bot's account and market; the levels of a Slingshot entry from
  // its `enter` event (same bot, symbol and moment). A new column is seen only by a later batch.
  [
    `ALTER TABLE bot_trades ADD account_id INT NULL, market ${t(8)} NULL, lev FLOAT NULL, sl FLOAT NULL, tp FLOAT NULL;`,
    `CREATE INDEX bot_trades_account ON bot_trades(account_id, closed_at);
    UPDATE t SET account_id = CASE WHEN b.execution = N'real' THEN b.account_id END, market = b.market FROM bot_trades t JOIN bots b ON b.id = t.bot_id;`,
    `UPDATE t SET sl = TRY_CAST(JSON_VALUE(e.detail, '$.sl') AS FLOAT), tp = TRY_CAST(JSON_VALUE(e.detail, '$.tp') AS FLOAT), lev = TRY_CAST(JSON_VALUE(e.detail, '$.leverage') AS FLOAT)
    FROM bot_trades t
    CROSS APPLY (SELECT TOP (1) x.detail FROM bot_events x WHERE x.bot_id = t.bot_id AND x.kind = N'enter' AND x.symbol = t.symbol AND x.at = t.opened_at AND ISJSON(x.detail) = 1 ORDER BY x.id DESC) e;`,
  ],
  // 12 — FD-CALACTUAL §3: the results a company reported (TradingView), kept apart from the calendar's events, which
  // the earnings refresh rewrites; one row per stock and day. §4: an indicator's former name the page knows.
  [
    `CREATE TABLE earn_results (
      symbol ${t(40)} NOT NULL,
      day ${t(10)} NOT NULL,
      released_at BIGINT NULL,
      eps FLOAT NULL,
      eps_forecast FLOAT NULL,
      eps_surprise_pct FLOAT NULL,
      revenue FLOAT NULL,
      revenue_forecast FLOAT NULL,
      revenue_surprise_pct FLOAT NULL,
      currency ${t(8)} NULL,
      fetched_at BIGINT NOT NULL,
      CONSTRAINT earn_results_pk PRIMARY KEY (symbol, day)
    );
    CREATE INDEX earn_results_day ON earn_results(day);`,
    // FD-CALACTUAL §4: the former name the page knows, for an indicator the source renamed.
    `ALTER TABLE econ_indicators ADD alt_name ${t('MAX')} NULL;`,
  ],
  // 13 — FD-PAPER: Paper Trading profiles (an account of their own, `exchange = paper`, its market in `kind`), with their
  // money and settings, positions (spot holdings, futures, shares), waiting orders and closed trades.
  [
    `ALTER TABLE exchange_accounts ADD kind ${t(10)} NULL;`,
    `CREATE TABLE paper_accounts (
      account_id INT NOT NULL PRIMARY KEY REFERENCES exchange_accounts(id) ON DELETE CASCADE,
      kind ${t(10)} NOT NULL,
      budget FLOAT NOT NULL,
      cash FLOAT NOT NULL,
      commission_type ${t(10)} NOT NULL,
      commission_value FLOAT NOT NULL,
      reset_at BIGINT NOT NULL,
      checked_at BIGINT NULL
    );
    CREATE TABLE paper_positions (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
      market ${t(8)} NOT NULL,
      symbol ${t(40)} NOT NULL,
      side ${t(5)} NOT NULL,
      qty FLOAT NOT NULL,
      entry FLOAT NOT NULL,
      leverage FLOAT NOT NULL,
      margin_mode ${t(10)} NOT NULL,
      margin FLOAT NOT NULL,
      sl FLOAT NULL,
      tp FLOAT NULL,
      fees FLOAT NOT NULL,
      opened_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      CONSTRAINT paper_positions_one UNIQUE (account_id, market, symbol)
    );
    CREATE TABLE paper_orders (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
      market ${t(8)} NOT NULL,
      symbol ${t(40)} NOT NULL,
      side ${t(4)} NOT NULL,
      kind ${t(12)} NOT NULL,
      qty FLOAT NOT NULL,
      price FLOAT NULL,
      trigger_price FLOAT NULL,
      leverage FLOAT NULL,
      margin_mode ${t(10)} NULL,
      reduce_only BIT NOT NULL DEFAULT 0,
      sl FLOAT NULL,
      tp FLOAT NULL,
      triggered BIT NOT NULL DEFAULT 0,
      reserved FLOAT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      checked_at BIGINT NOT NULL
    );
    CREATE INDEX paper_orders_account ON paper_orders(account_id);
    CREATE TABLE paper_trades (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      account_id INT NOT NULL REFERENCES exchange_accounts(id) ON DELETE CASCADE,
      market ${t(8)} NOT NULL,
      symbol ${t(40)} NOT NULL,
      side ${t(5)} NOT NULL,
      qty FLOAT NOT NULL,
      entry FLOAT NOT NULL,
      [exit] FLOAT NOT NULL,
      pnl FLOAT NOT NULL,
      fees FLOAT NOT NULL,
      leverage FLOAT NOT NULL,
      sl FLOAT NULL,
      tp FLOAT NULL,
      opened_at BIGINT NOT NULL,
      closed_at BIGINT NOT NULL,
      reason ${t(16)} NOT NULL
    );
    CREATE INDEX paper_trades_account ON paper_trades(account_id, closed_at);`,
  ],
  // 14 — FIX-PAPERLEV: a profile's spot coins become positions like the others (leverage 1, their cost held as margin,
  // not spent): the cost goes back into the money, and is held as the position's margin.
  [
    `UPDATE a SET cash = a.cash + x.cost FROM paper_accounts a JOIN (SELECT account_id, SUM(qty * entry) AS cost FROM paper_positions WHERE market = N'spot' AND margin = 0 GROUP BY account_id) x ON x.account_id = a.account_id;`,
    `UPDATE paper_positions SET margin = qty * entry, leverage = 1 WHERE market = N'spot' AND margin = 0;`,
  ],
  // 15 — FIX-SOURCES: FXStreet answers Azure with 403 (Cloudflare blocks its data-center addresses, since 16 Oct 2026):
  // the built-in source is turned off once; the user may turn it on again (Setări → Admin → Surse).
  [`UPDATE sources SET enabled = 0 WHERE id = N'fxstreet' AND builtin = 1;`],
  // 16 — FD-PUSH: the user's devices for notifications (APNs), a bot's bell, and the positions watched until their stop
  // loss / take profit closes them (an order sent with the form's bell). `account_id` without a key, as in trade_log
  // (a watch of a deleted account ends at its next look).
  [
    `CREATE TABLE push_devices (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token ${t(200)} NOT NULL,
      env ${t(16)} NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX push_devices_token ON push_devices(token);
    CREATE INDEX push_devices_user ON push_devices(user_id);`,
    `ALTER TABLE bots ADD notify BIT NOT NULL CONSTRAINT bots_notify_default DEFAULT 0;`,
    `CREATE TABLE trade_watches (
      id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id INT NOT NULL,
      idem_key ${t(64)} NULL,
      market ${t(16)} NOT NULL,
      symbol ${t(80)} NOT NULL,
      side ${t(8)} NOT NULL,
      sl FLOAT NULL,
      tp FLOAT NULL,
      state ${t(16)} NOT NULL,
      seen_open BIT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      checked_at BIGINT NULL,
      ended_at BIGINT NULL,
      result ${t('MAX')} NULL
    );
    CREATE INDEX trade_watches_open ON trade_watches(state, account_id);`,
  ],
  // FIX-SOURCEDELETE: the sources the admin deleted for good (a built-in, a stock's automatic feed): the start
  // (`seedSources`) and the watch lists (`syncStockSources`) never bring them back.
  [
    `CREATE TABLE deleted_sources (
      source_id ${t(200)} NOT NULL PRIMARY KEY,
      url ${t('MAX')} NOT NULL,
      deleted_at BIGINT NOT NULL
    );`,
  ],
];

const VERSION_TABLE = "OBJECT_ID(QUOTENAME(SCHEMA_NAME()) + N'.schema_version', N'U')";

/** The schema version of the caller's default schema (0 when it has no tables yet). */
export async function schemaVersion(db: Db): Promise<number> {
  const exists = await db.get<{ x: number }>(`SELECT CASE WHEN ${VERSION_TABLE} IS NULL THEN 0 ELSE 1 END AS x`);
  if (!exists?.x) return 0;
  return (await db.get<{ version: number }>('SELECT TOP (1) version FROM schema_version'))?.version ?? 0;
}

/** Applies the missing migrations in one transaction (under the write lock: two processes never both migrate). */
export async function migrate(db: Db): Promise<void> {
  const newer = (v: number) => new Error(`Schema bazei de date (versiunea ${v}) e mai nouă decât acest Sentiq (versiunea ${MIGRATIONS.length}): actualizează Sentiq.`);
  const seen = await schemaVersion(db);
  if (seen > MIGRATIONS.length) throw newer(seen);
  if (seen === MIGRATIONS.length) return;
  await db.tx(async () => {
    await db.run(`IF ${VERSION_TABLE} IS NULL BEGIN CREATE TABLE schema_version (version INT NOT NULL); INSERT INTO schema_version (version) VALUES (0); END`);
    const from = await schemaVersion(db);
    if (from > MIGRATIONS.length) throw newer(from);
    for (let i = from; i < MIGRATIONS.length; i++) {
      try {
        for (const batch of MIGRATIONS[i]!) await db.run(batch);
      } catch (err) {
        throw new Error(`Migration ${i + 1} failed: ${(err as Error).message}`, { cause: err });
      }
      await db.run('UPDATE schema_version SET version = ?', [i + 1]);
    }
  });
}
