/**
 * db/init.js
 * -------------------------------------------------------------
 * 啟動時自動執行的 schema 初始化 / 升級腳本。
 *
 * 原則:
 *   - 全部用 CREATE TABLE IF NOT EXISTS / ALTER TABLE ...
 *     ADD COLUMN IF NOT EXISTS，所以重跑不會破壞現有資料。
 *   - 新增欄位 / 新表請加在這裡，不要分散到各 route 檔的
 *     top-level pool.query()（那會被 .catch(()=>{}) 吞錯）。
 *   - ALTER TABLE 語句必須在對應 CREATE TABLE 之後，否則
 *     全新部署時會因表不存在而啟動失敗。
 *
 * Bootstrap:
 *   第一次啟動且 users 表為空時，建立 admin 超管帳號。
 *   密碼優先讀 INITIAL_ADMIN_PASSWORD；沒設則隨機產生一次並印到 stdout。
 *   密碼以 pbkdf2$salt$hash 儲存，不落明文。
 *   （舊共用「管理員密碼」已移除，改由 users 表管理各自帳密）
 */
const pool = require('./pool');

const initDatabase = async () => {
  const client = await pool.connect();
  try {
    console.log('[initDB] 開始建表...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_history (
        id SERIAL PRIMARY KEY, file_name VARCHAR(255) NOT NULL,
        file_type VARCHAR(50), branch VARCHAR(10), period VARCHAR(6),
        row_count INTEGER DEFAULT 0, status VARCHAR(20) DEFAULT 'success',
        error_msg TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS repair_income (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        work_order VARCHAR(30), settle_date DATE, clear_date DATE, customer VARCHAR(100), plate_no VARCHAR(20),
        account_type_code VARCHAR(10), account_type VARCHAR(30),
        parts_income NUMERIC(12,2) DEFAULT 0, accessories_income NUMERIC(12,2) DEFAULT 0,
        boutique_income NUMERIC(12,2) DEFAULT 0, engine_wage NUMERIC(12,2) DEFAULT 0,
        bodywork_income NUMERIC(12,2) DEFAULT 0, paint_income NUMERIC(12,2) DEFAULT 0,
        carwash_income NUMERIC(12,2) DEFAULT 0, outsource_income NUMERIC(12,2) DEFAULT 0,
        addon_income NUMERIC(12,2) DEFAULT 0, total_untaxed NUMERIC(12,2) DEFAULT 0,
        total_taxed NUMERIC(12,2) DEFAULT 0, parts_cost NUMERIC(12,2) DEFAULT 0,
        service_advisor VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tech_performance (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        tech_name_raw VARCHAR(50), tech_name_clean VARCHAR(50), dispatch_date DATE,
        work_order VARCHAR(30), work_code VARCHAR(30), task_content VARCHAR(200),
        standard_hours NUMERIC(8,2) DEFAULT 0, wage NUMERIC(12,2) DEFAULT 0,
        account_type VARCHAR(30), discount NUMERIC(5,2), wage_category VARCHAR(30),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_sales (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        category VARCHAR(20), category_detail VARCHAR(50), order_no VARCHAR(30),
        work_order VARCHAR(30), part_number VARCHAR(30), part_name VARCHAR(200),
        part_type VARCHAR(20), category_code VARCHAR(20), function_code VARCHAR(20),
        sale_qty NUMERIC(10,2) DEFAULT 0, retail_price NUMERIC(12,2) DEFAULT 0,
        sale_price_untaxed NUMERIC(12,2) DEFAULT 0, cost_untaxed NUMERIC(12,2) DEFAULT 0,
        discount_rate NUMERIC(5,4), department VARCHAR(20), pickup_person VARCHAR(50),
        sales_person VARCHAR(50), plate_no VARCHAR(20), created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS business_query (
        id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
        work_order VARCHAR(30), open_time TIMESTAMPTZ, settle_date DATE,
        plate_no VARCHAR(20), vin VARCHAR(30), status VARCHAR(20), repair_item TEXT,
        service_advisor VARCHAR(50), assigned_tech VARCHAR(50), repair_tech VARCHAR(50),
        repair_type VARCHAR(50), car_series VARCHAR(50), car_model VARCHAR(50),
        model_year VARCHAR(10), owner VARCHAR(100), is_ev VARCHAR(10),
        mileage_in INTEGER, mileage_out INTEGER,
        repair_amount NUMERIC(12,2) DEFAULT 0,
        labor_fee NUMERIC(12,2) DEFAULT 0,
        repair_material_fee NUMERIC(12,2) DEFAULT 0,
        sales_material_fee NUMERIC(12,2) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    // 舊資料庫補欄位
    await client.query(`ALTER TABLE business_query ADD COLUMN IF NOT EXISTS repair_amount NUMERIC(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE business_query ADD COLUMN IF NOT EXISTS labor_fee NUMERIC(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE business_query ADD COLUMN IF NOT EXISTS repair_material_fee NUMERIC(12,2) DEFAULT 0`);
    await client.query(`ALTER TABLE business_query ADD COLUMN IF NOT EXISTS sales_material_fee NUMERIC(12,2) DEFAULT 0`);
    // DMS 交修項目名稱常串接多筆，易超過 200 字 → 改 TEXT 免被截斷
    await client.query(`ALTER TABLE business_query ALTER COLUMN repair_item TYPE TEXT`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN account_type TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN account_type_code TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN account_type TYPE VARCHAR(100)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN work_order TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN customer TYPE VARCHAR(200)`);
    await client.query(`ALTER TABLE tech_performance ALTER COLUMN account_type TYPE VARCHAR(100)`);
    await client.query(`ALTER TABLE tech_performance ALTER COLUMN work_code TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE tech_performance ALTER COLUMN work_order TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE repair_income ADD COLUMN IF NOT EXISTS clear_date DATE`);

    const bqCheck = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='business_query' AND column_name='work_order'`
    );
    if (!bqCheck.rows.length) {
      await client.query(`DROP TABLE IF EXISTS business_query`);
      await client.query(`
        CREATE TABLE business_query (
          id SERIAL PRIMARY KEY, period VARCHAR(6), branch VARCHAR(10),
          work_order VARCHAR(30), open_time TIMESTAMPTZ, settle_date DATE,
          plate_no VARCHAR(20), vin VARCHAR(30), status VARCHAR(20), repair_item TEXT,
          service_advisor VARCHAR(50), assigned_tech VARCHAR(50), repair_tech VARCHAR(50),
          repair_type VARCHAR(50), car_series VARCHAR(50), car_model VARCHAR(50),
          model_year VARCHAR(10), owner VARCHAR(100), is_ev VARCHAR(10),
          mileage_in INTEGER, mileage_out INTEGER, created_at TIMESTAMPTZ DEFAULT NOW()
        )`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS parts_catalog (
        part_number VARCHAR(50) PRIMARY KEY, part_name VARCHAR(200),
        part_category VARCHAR(50), part_type VARCHAR(20), category_code VARCHAR(20),
        function_code VARCHAR(20), branch VARCHAR(10), updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sa_sales_config (
        id SERIAL PRIMARY KEY, config_name VARCHAR(100) NOT NULL,
        description TEXT, filters JSONB NOT NULL DEFAULT '[]',
        stat_method VARCHAR(20) NOT NULL DEFAULT 'amount',
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`ALTER TABLE sa_sales_config ADD COLUMN IF NOT EXISTS stat_method VARCHAR(20) NOT NULL DEFAULT 'amount'`);
    await client.query(`ALTER TABLE sa_sales_config ADD COLUMN IF NOT EXISTS person_type VARCHAR(20) NOT NULL DEFAULT 'sales_person'`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL)`);
    // 舊版共用「管理員密碼」已移除；保留 app_settings.settings_password 資料列
    // 以避免 rollback 時 /api/auth/settings 暫時不可用。新系統使用
    // users 表 + /api/users/:id/password 管理各人密碼。

    await client.query(`
      CREATE TABLE IF NOT EXISTS income_config (
        id SERIAL PRIMARY KEY, config_key VARCHAR(50) NOT NULL UNIQUE,
        config_value TEXT NOT NULL, description TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`
      INSERT INTO income_config (config_key, config_value, description)
      VALUES ('external_sales_category','外賣','外賣收入對應 parts_sales.category 值')
      ON CONFLICT (config_key) DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS working_days_config (
        id         SERIAL PRIMARY KEY,
        branch     VARCHAR(10) NOT NULL,
        period     VARCHAR(6)  NOT NULL,
        work_dates JSONB       NOT NULL DEFAULT '[]',
        note       TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (branch, period)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_metrics (
        id          SERIAL PRIMARY KEY,
        metric_name VARCHAR(100) NOT NULL,
        description TEXT    DEFAULT '',
        metric_type VARCHAR(20) NOT NULL DEFAULT 'repair_income',
        filters     JSONB   NOT NULL DEFAULT '[]',
        stat_field  VARCHAR(20) NOT NULL DEFAULT 'amount',
        unit        VARCHAR(20) DEFAULT '',
        sort_order  INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS performance_targets (
        id              SERIAL PRIMARY KEY,
        metric_id       INTEGER NOT NULL,
        branch          VARCHAR(10) NOT NULL,
        period          VARCHAR(6)  NOT NULL,
        target_value    NUMERIC(15,2),
        last_year_value NUMERIC(15,2),
        note            TEXT DEFAULT '',
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(metric_id, branch, period)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS revenue_targets (
        id              SERIAL PRIMARY KEY,
        branch          VARCHAR(10)  NOT NULL,
        period          VARCHAR(6)   NOT NULL,
        paid_target     NUMERIC(15,2),
        paid_last_year  NUMERIC(15,2),
        bodywork_target     NUMERIC(15,2),
        bodywork_last_year  NUMERIC(15,2),
        general_target  NUMERIC(15,2),
        general_last_year   NUMERIC(15,2),
        extended_target NUMERIC(15,2),
        extended_last_year  NUMERIC(15,2),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(branch, period)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tech_wage_configs (
        id          SERIAL PRIMARY KEY,
        config_name VARCHAR(100) NOT NULL,
        description TEXT DEFAULT '',
        work_codes  JSONB NOT NULL DEFAULT '[]',
        account_types JSONB NOT NULL DEFAULT '[]',
        stat_method VARCHAR(20) NOT NULL DEFAULT 'count',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS revenue_estimates (
        id              SERIAL PRIMARY KEY,
        branch          VARCHAR(10)  NOT NULL,
        period          VARCHAR(6)   NOT NULL,
        paid_estimate     NUMERIC(15,2),
        bodywork_estimate NUMERIC(15,2),
        general_estimate  NUMERIC(15,2),
        extended_estimate NUMERIC(15,2),
        note            TEXT DEFAULT '',
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(branch, period)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS revenue_estimate_history (
        id                SERIAL PRIMARY KEY,
        period            VARCHAR(6)   NOT NULL,
        week_key          VARCHAR(10)  NOT NULL,
        week_label        VARCHAR(30)  DEFAULT '',
        branch            VARCHAR(10)  NOT NULL,
        paid_estimate     NUMERIC(15,2),
        bodywork_estimate NUMERIC(15,2),
        general_estimate  NUMERIC(15,2),
        extended_estimate NUMERIC(15,2),
        submitted_at      TIMESTAMPTZ  DEFAULT NOW(),
        note              TEXT         DEFAULT '',
        UNIQUE(period, week_key, branch)
      )`);

    // ── 人員名冊 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_roster (
        id                SERIAL PRIMARY KEY,
        period            VARCHAR(6)  NOT NULL,
        emp_id            VARCHAR(20) NOT NULL,
        emp_name          VARCHAR(50),
        dept_code         VARCHAR(20),
        dept_name         VARCHAR(100),
        job_title         VARCHAR(100),
        status            VARCHAR(20),
        hire_date         DATE,
        resign_date       DATE,
        unpaid_leave_date DATE,
        reinstated_date   DATE,
        mgr1              VARCHAR(100),
        mgr2              VARCHAR(100),
        factory           VARCHAR(20),
        job_category      VARCHAR(50),
        job_class         VARCHAR(50),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (period, emp_id)
      )`);
    await client.query(`ALTER TABLE staff_roster ADD COLUMN IF NOT EXISTS reinstated_date DATE`);

    // ── 獎金指標 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS bonus_metrics (
        id            SERIAL PRIMARY KEY,
        metric_name   VARCHAR(100) NOT NULL,
        description   TEXT DEFAULT '',
        scope_type    VARCHAR(20) NOT NULL DEFAULT 'person',
        scope_value   VARCHAR(100) DEFAULT '',
        metric_source VARCHAR(30)  NOT NULL DEFAULT 'manual',
        filters       JSONB NOT NULL DEFAULT '[]',
        stat_field    VARCHAR(30) DEFAULT 'amount',
        unit          VARCHAR(20) DEFAULT '',
        sort_order    INTEGER DEFAULT 0,
        target_dept_codes JSONB DEFAULT '[]',
        bonus_rule    JSONB DEFAULT '{}',
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )`);

    // ── bonus_metrics 補欄位（舊版升級用）──
    await client.query(`ALTER TABLE bonus_metrics ADD COLUMN IF NOT EXISTS target_dept_codes JSONB DEFAULT '[]'`);
    await client.query(`ALTER TABLE bonus_metrics ADD COLUMN IF NOT EXISTS bonus_rule JSONB DEFAULT '{}'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS bonus_targets (
        id               SERIAL PRIMARY KEY,
        metric_id        INTEGER NOT NULL,
        emp_id           VARCHAR(20),
        dept_code        VARCHAR(20),
        period           VARCHAR(6) NOT NULL,
        target_value     NUMERIC(15,2),
        last_year_value  NUMERIC(15,2),
        bonus_rule       JSONB DEFAULT '{}',
        note             TEXT DEFAULT '',
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS bonus_targets_unique_idx
      ON bonus_targets (metric_id, COALESCE(emp_id,''), COALESCE(dept_code,''), period)
    `);

    // ── 個人業績目標 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS person_metric_targets (
        id            SERIAL PRIMARY KEY,
        metric_id     INTEGER NOT NULL,
        period        VARCHAR(6)   NOT NULL,
        branch        VARCHAR(10)  NOT NULL,
        person_name   VARCHAR(100) NOT NULL,
        weight        NUMERIC(7,4),
        target_value  NUMERIC(15,2),
        note          TEXT DEFAULT '',
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(metric_id, period, branch, person_name)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wip_status_notes (
        id          SERIAL PRIMARY KEY,
        work_order  VARCHAR(50) NOT NULL,
        branch      VARCHAR(10) NOT NULL,
        wip_status  VARCHAR(20) NOT NULL DEFAULT '未填寫',
        eta_date    DATE,
        reason      TEXT DEFAULT '',
        updated_by  VARCHAR(50) DEFAULT '',
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(work_order, branch)
      )`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS wip_status_history (
        id          BIGSERIAL PRIMARY KEY,
        work_order  VARCHAR(50) NOT NULL,
        branch      VARCHAR(10) NOT NULL,
        wip_status  VARCHAR(20),
        eta_date    DATE,
        reason      TEXT,
        updated_by  VARCHAR(50),
        user_id     INTEGER,
        username    VARCHAR(50),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wip_hist_wo ON wip_status_history(work_order, branch, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_wip_hist_created ON wip_status_history(created_at DESC)`);

// ── VCTL 商務政策指標 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS vctl_metrics (
        id            SERIAL PRIMARY KEY,
        metric_name   VARCHAR(100) NOT NULL,
        description   TEXT DEFAULT '',
        source_type   VARCHAR(20) NOT NULL DEFAULT 'parts',
        calc_method   VARCHAR(20) NOT NULL DEFAULT 'amount',
        account_types JSONB NOT NULL DEFAULT '[]',
        filters       JSONB NOT NULL DEFAULT '[]',
        unit          VARCHAR(20) DEFAULT '',
        sort_order    INTEGER DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )`);
    
// ──新建銷售獎金 
      await client.query(`
      CREATE TABLE IF NOT EXISTS promo_bonus_configs (
        id SERIAL PRIMARY KEY,
        rule_name VARCHAR(100) NOT NULL,
        rule_type VARCHAR(20) NOT NULL DEFAULT 'sa_qty',
        sa_config_id INTEGER,
        per_qty NUMERIC(10,2) DEFAULT 1,
        bonus_per_unit NUMERIC(12,2) DEFAULT 0,
        part_catalog_types JSONB DEFAULT '[]',
        paycode_types JSONB DEFAULT '[]',
        discount_min NUMERIC(5,4),
        discount_max NUMERIC(5,4),
        bonus_pct NUMERIC(7,4) DEFAULT 0,
        role_amounts JSONB DEFAULT '{}',
        target_factories JSONB DEFAULT '[]',
        active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);

    await client.query(`
    CREATE TABLE IF NOT EXISTS manager_review (
      id         SERIAL PRIMARY KEY,
      period     VARCHAR(6)  NOT NULL,
      emp_id     VARCHAR(20) NOT NULL,
      amount     INTEGER     NOT NULL DEFAULT 0,
      note       TEXT,
      updated_at TIMESTAMP   DEFAULT NOW(),
      UNIQUE(period, emp_id)
    )
  `);

await client.query(`
      CREATE TABLE IF NOT EXISTS bonus_actual_overrides (
        id           SERIAL PRIMARY KEY,
        metric_id    INTEGER NOT NULL,
        period       VARCHAR(6)  NOT NULL,
        branch       VARCHAR(10) DEFAULT '',
        actual_value NUMERIC(15,2),
        note         TEXT DEFAULT '',
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      )`);

await client.query(`DROP INDEX IF EXISTS bonus_actual_overrides_unique_idx`);
await client.query(`UPDATE bonus_actual_overrides SET branch='' WHERE branch IS NULL`);
await client.query(`ALTER TABLE bonus_actual_overrides ALTER COLUMN branch SET NOT NULL`);
await client.query(`ALTER TABLE bonus_actual_overrides ALTER COLUMN branch SET DEFAULT ''`);
await client.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS bonus_actual_overrides_unique_idx
  ON bonus_actual_overrides (metric_id, period, branch)
`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS beauty_op_hours (
        op_code        VARCHAR(20) PRIMARY KEY,
        description    VARCHAR(200) DEFAULT '',
        standard_hours NUMERIC(8,2) NOT NULL DEFAULT 0,
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      )`);

    // ── 業務鈑烤取送獎金申請 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS bodyshop_bonus_applications (
        id               SERIAL PRIMARY KEY,
        app_period       VARCHAR(6)   NOT NULL,
        apply_date       DATE,
        applicant_name   VARCHAR(50),
        emp_id           VARCHAR(30),
        dept_name        VARCHAR(100),
        plate_no_raw     VARCHAR(30),
        plate_no_norm    VARCHAR(20),
        factory_raw      VARCHAR(30),
        branch           VARCHAR(10),
        status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
        work_order       VARCHAR(50),
        repair_type      VARCHAR(50),
        settle_date      DATE,
        income_total     NUMERIC(12,2),
        bonus_rate       NUMERIC(5,4) DEFAULT 0.02,
        bonus_amount     NUMERIC(12,2),
        settled_period   VARCHAR(6),
        note             TEXT DEFAULT '',
        upload_batch     VARCHAR(50),
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bba_period ON bodyshop_bonus_applications(app_period)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bba_plate  ON bodyshop_bonus_applications(plate_no_norm)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bba_status ON bodyshop_bonus_applications(status)`);
    await client.query(`ALTER TABLE promo_bonus_configs ADD COLUMN IF NOT EXISTS tiers JSONB DEFAULT '[]'`);
    await client.query(`ALTER TABLE promo_bonus_configs ADD COLUMN IF NOT EXISTS stat_method VARCHAR(20) DEFAULT 'amount'`);
    await client.query(`ALTER TABLE promo_bonus_configs ADD COLUMN IF NOT EXISTS person_type VARCHAR(20) DEFAULT 'sales_person'`);
    await client.query(`ALTER TABLE bodyshop_bonus_applications ADD COLUMN IF NOT EXISTS source_app_id INTEGER`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bba_source ON bodyshop_bonus_applications(source_app_id)`);
    try {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_bba_source_app') THEN
            ALTER TABLE bodyshop_bonus_applications
              ADD CONSTRAINT fk_bba_source_app
              FOREIGN KEY (source_app_id)
              REFERENCES bodyshop_bonus_applications(id) ON DELETE CASCADE;
          END IF;
        END$$
      `);
    } catch(e) { console.warn('[initDB] FK source_app_id:', e.message); }

await client.query(`
  CREATE TABLE IF NOT EXISTS bonus_extra (
    id SERIAL PRIMARY KEY,
    period VARCHAR(6) NOT NULL,
    emp_id VARCHAR(20),
    emp_name VARCHAR(100),
    branch VARCHAR(20),
    dept_code VARCHAR(20),
    amount INTEGER DEFAULT 0,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`);

// 獎金電子簽核（主管確認核發金額後於 檢查人 欄位簽名）
await client.query(`
  CREATE TABLE IF NOT EXISTS bonus_signatures (
    id SERIAL PRIMARY KEY,
    period VARCHAR(6) NOT NULL,
    branch VARCHAR(50) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'checker',
    signer_name VARCHAR(100) NOT NULL,
    signer_emp_id VARCHAR(50),
    signature_data TEXT NOT NULL,
    signed_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (period, branch, role)
  )
`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_bonus_sig_period ON bonus_signatures(period)`);

// 技師工時「不計目標」清單（跨使用者共用；會影響工時表顯示與獎金工時指標）
await client.query(`
  CREATE TABLE IF NOT EXISTS tech_hours_excludes (
    period     VARCHAR(6)  NOT NULL,
    branch     VARCHAR(20) NOT NULL,
    emp_name   VARCHAR(50) NOT NULL,
    updated_by VARCHAR(50),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (period, branch, emp_name)
  )
`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_tech_ex_period ON tech_hours_excludes(period, branch)`);

    // ── 查詢效能索引 ──
await client.query(`CREATE INDEX IF NOT EXISTS idx_repair_income_period_branch ON repair_income(period, branch)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_tech_performance_period_branch ON tech_performance(period, branch)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_parts_sales_period_branch ON parts_sales(period, branch)`);
await client.query(`CREATE INDEX IF NOT EXISTS idx_business_query_period_branch ON business_query(period, branch)`);

// ── 使用者帳號系統 ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        username      VARCHAR(50)  NOT NULL UNIQUE,
        password_hash VARCHAR(100) NOT NULL,
        password_salt VARCHAR(50)  NOT NULL,
        display_name  VARCHAR(100) NOT NULL DEFAULT '',
        role          VARCHAR(20)  NOT NULL DEFAULT 'user',
        branch        VARCHAR(10),
        is_active     BOOLEAN      NOT NULL DEFAULT true,
        last_login    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ  DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        id             SERIAL PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission_key VARCHAR(60) NOT NULL,
        UNIQUE(user_id, permission_key)
      )
    `);

    // 新增 feature:bonus_sign（獎金簽核）權限：讓所有已能瀏覽獎金表（page:bonus）
    // 的使用者自動獲得簽核權限，免去管理員逐一設定。僅執行一次，ON CONFLICT 忽略。
    await client.query(`
      INSERT INTO user_permissions (user_id, permission_key)
      SELECT user_id, 'feature:bonus_sign' FROM user_permissions
      WHERE permission_key = 'page:bonus'
      ON CONFLICT (user_id, permission_key) DO NOTHING
    `);

    // ─────────────────────────────────────────────────────────
    // 權限拆分 migration（feature:upload / feature:targets / feature:bonus_edit）
    // 舊鍵保留於 DB，但所有後端路由已改用新鍵；將現有擁有者一次性展開為對應新鍵。
    // ON CONFLICT DO NOTHING → 再次啟動亦安全。
    // ─────────────────────────────────────────────────────────
    const MIGRATIONS = [
      // 舊 feature:upload → 4 支新上傳權限
      ['feature:upload', 'feature:upload_dms'],
      ['feature:upload', 'feature:upload_roster'],
      ['feature:upload', 'feature:upload_targets'],
      ['feature:upload', 'feature:upload_bodyshop'],
      // 舊 feature:targets → 3 支新目標權限
      ['feature:targets', 'feature:perf_metric_edit'],
      ['feature:targets', 'feature:perf_target_edit'],
      ['feature:targets', 'feature:revenue_target_edit'],
      // 舊 feature:bonus_edit → 7 支新編輯權限
      ['feature:bonus_edit', 'feature:bonus_metric_edit'],
      ['feature:bonus_edit', 'feature:bonus_extra_edit'],
      ['feature:bonus_edit', 'feature:promo_bonus_edit'],
      ['feature:bonus_edit', 'feature:bodyshop_bonus_edit'],
      ['feature:bonus_edit', 'feature:sa_config_edit'],
      ['feature:bonus_edit', 'feature:tech_config_edit'],
      // page:monthly → 月報編輯（原本只有 requireAuth，升級為需要編輯權）
      ['page:monthly', 'feature:monthly_edit'],
      // page:stats → WIP 編輯（同上）
      ['page:stats', 'feature:wip_edit'],
      // feature:user_manage → 自動帶「重設他人密碼」
      ['feature:user_manage', 'feature:password_reset'],
      // 原本能編輯系統設定的 page:settings 使用者 → feature:sys_config_edit
      ['page:settings', 'feature:sys_config_edit'],
      // ── 資料匯出權限（防外洩；預設只給原本的「編輯者 / 管理員」） ──
      ['feature:bonus_edit',  'feature:export_bonus'],
      ['feature:bonus_edit',  'feature:export_data'],
      ['feature:targets',     'feature:export_data'],
      ['feature:user_manage', 'feature:export_audit'],
      // 據點主管自動獲得上傳簽核（一階）權限
      ['branch:AMA', 'feature:approve_upload_branch'],
      ['branch:AMC', 'feature:approve_upload_branch'],
      ['branch:AMD', 'feature:approve_upload_branch'],
      ['branch:AME', 'feature:approve_upload_branch'],
    ];
    for (const [from, to] of MIGRATIONS) {
      await client.query(`
        INSERT INTO user_permissions (user_id, permission_key)
        SELECT user_id, $2 FROM user_permissions WHERE permission_key = $1
        ON CONFLICT (user_id, permission_key) DO NOTHING
      `, [from, to]);
    }

    // ─────────────────────────────────────────────────────────
    // 上傳簽核申請（一般使用者想上傳已鎖定期間 → 雙階段審核）
    // 階段：pending → branch_approved → executed | rejected | withdrawn | expired
    // ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS upload_approval_requests (
        id                    SERIAL PRIMARY KEY,
        requester_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requester_username    VARCHAR(50),
        requester_name        VARCHAR(100),
        period                VARCHAR(6)  NOT NULL,
        branch                VARCHAR(10),
        upload_type           VARCHAR(30) NOT NULL,
          -- 'dms' / 'roster' / 'perf_targets' / 'revenue_targets' /
          -- 'revenue_targets_native' / 'bodyshop'
        replay_endpoint       VARCHAR(100) NOT NULL,
        file_name             VARCHAR(255),
        file_content          BYTEA,
        file_size             INTEGER,
        extra_body            JSONB DEFAULT '{}',
        reason                TEXT,

        status                VARCHAR(20) NOT NULL DEFAULT 'pending',
        branch_approver_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        branch_approver_name  VARCHAR(100),
        branch_approved_at    TIMESTAMPTZ,
        branch_approve_note   TEXT,

        super_approver_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        super_approver_name   VARCHAR(100),
        super_approved_at     TIMESTAMPTZ,
        super_approve_note    TEXT,

        rejector_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
        rejector_name         VARCHAR(100),
        rejected_at           TIMESTAMPTZ,
        reject_note           TEXT,

        executed_at           TIMESTAMPTZ,
        execute_result        JSONB,
        execute_error         TEXT,

        created_at            TIMESTAMPTZ DEFAULT NOW(),
        expires_at            TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_uar_status     ON upload_approval_requests(status, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_uar_requester  ON upload_approval_requests(requester_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_uar_branch     ON upload_approval_requests(branch, status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        token      VARCHAR(70)  PRIMARY KEY,
        user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ  NOT NULL,
        created_at TIMESTAMPTZ  DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user    ON user_sessions(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at)`);

   // ── 操作紀錄 ──
  await client.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id               BIGSERIAL     PRIMARY KEY,
      user_id          INTEGER,
      username         VARCHAR(50)   NOT NULL DEFAULT 'anonymous',
      display_name     VARCHAR(100)  DEFAULT '',
      user_role        VARCHAR(20)   DEFAULT '',
      user_branch      VARCHAR(10),
      ip_address       VARCHAR(60)   NOT NULL DEFAULT '0.0.0.0',
      user_agent       VARCHAR(300)  DEFAULT '',
      action           VARCHAR(30)   NOT NULL,
        -- VIEW / UPLOAD / DOWNLOAD / CREATE / UPDATE / DELETE
        -- LOGIN / LOGOUT / SUBMIT / USER_MGMT / PWD_CHANGE
      resource         VARCHAR(200)  DEFAULT '',
      resource_path    VARCHAR(300)  DEFAULT '',
      resource_detail  TEXT,
      data_branch      VARCHAR(10),
      data_period      VARCHAR(6),
      status_code      SMALLINT,
      duration_ms      INTEGER,
      created_at       TIMESTAMPTZ   DEFAULT NOW()
    )
  `);
  // 效能索引
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_created  ON audit_logs(created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_user     ON audit_logs(username, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_action   ON audit_logs(action, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_ip       ON audit_logs(ip_address, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_branch   ON audit_logs(user_branch, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_al_data_br  ON audit_logs(data_branch)`);
 
  // 自動分區清理（可選）：保留 180 天
  // 若資料量龐大，可考慮設定 pg_partman 或排程清理

    // ── pbkdf2 漸進升級用：紀錄每個 hash 的 iteration 數 ──
    // 預設 100000（相容既有 row）；新建 / 重設密碼會寫 600000
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_iterations INTEGER NOT NULL DEFAULT 100000`);

    // ── 建立預設超管帳號（若無任何使用者）──
    const _uc = await client.query(`SELECT COUNT(*) FROM users`);
    if (parseInt(_uc.rows[0].count) === 0) {
      const _cr   = require('crypto');
      const _env  = process.env.INITIAL_ADMIN_PASSWORD;
      const _isProd = process.env.NODE_ENV === 'production';
      // 安全：production 必填 INITIAL_ADMIN_PASSWORD，不再印隨機密碼到 stdout
      // （避免 Zeabur 等雲端 log 保留導致密碼外洩）
      if (_isProd && !_env) {
        throw new Error('[initDB] production 環境必須設定 INITIAL_ADMIN_PASSWORD 環境變數，否則拒絕建立預設管理員');
      }
      const _pwd  = _env || _cr.randomBytes(12).toString('base64url'); // dev only
      if (_pwd.length < 10) {
        throw new Error('[initDB] INITIAL_ADMIN_PASSWORD 至少 10 個字元');
      }
      const _ITER = 600000;
      const _salt = _cr.randomBytes(16).toString('hex');
      const _hash = _cr.pbkdf2Sync(_pwd, _salt, _ITER, 32, 'sha256').toString('hex');
      await client.query(
        `INSERT INTO users (username, password_hash, password_salt, password_iterations, display_name, role)
         VALUES ('admin', $1, $2, $3, '系統管理員', 'super_admin')
         ON CONFLICT (username) DO NOTHING`,
        [_hash, _salt, _ITER]
      );
      if (_env) {
        console.log('[initDB] ✅ 預設管理員已建立: admin（使用 INITIAL_ADMIN_PASSWORD 指定的密碼）');
      } else {
        console.log(`[initDB] ✅ 預設管理員已建立: admin / ${_pwd}（dev 模式自動產生，請立即變更，此訊息僅顯示一次）`);
      }
    }

    console.log('[initDB] ✅ 所有表格建立完成');
  } catch (err) {
    console.error('[initDB] ❌ 失敗:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = initDatabase;
