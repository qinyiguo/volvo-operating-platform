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
        work_order VARCHAR(30), settle_date DATE, customer VARCHAR(100), plate_no VARCHAR(20),
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
        plate_no VARCHAR(20), vin VARCHAR(30), status VARCHAR(20), repair_item VARCHAR(200),
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
    await client.query(`ALTER TABLE repair_income ALTER COLUMN account_type TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN account_type_code TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN account_type TYPE VARCHAR(100)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN work_order TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE repair_income ALTER COLUMN customer TYPE VARCHAR(200)`);
    await client.query(`ALTER TABLE tech_performance ALTER COLUMN account_type TYPE VARCHAR(100)`);
    await client.query(`ALTER TABLE tech_performance ALTER COLUMN work_code TYPE VARCHAR(50)`);
    await client.query(`ALTER TABLE tech_performance ALTER COLUMN work_order TYPE VARCHAR(50)`);

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
          plate_no VARCHAR(20), vin VARCHAR(30), status VARCHAR(20), repair_item VARCHAR(200),
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
    await client.query(`
      INSERT INTO app_settings (key, value) VALUES ('settings_password','admin1234')
      ON CONFLICT (key) DO NOTHING`);

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

    console.log('[initDB] ✅ 所有表格建立完成');
  } catch (err) {
    console.error('[initDB] ❌ 失敗:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = initDatabase;
