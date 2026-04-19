/**
 * lib/batchInsert.js
 * -------------------------------------------------------------
 * 大量寫入 helper：把解析後的 Excel rows 以 500 筆 / 200 筆為一組
 * 批次 INSERT，避免逐筆 query 造成的效能問題。
 *
 *   batchInsert(client, table, cols, rows)
 *     一次性欄位對齊 INSERT（500 筆/批）。client 需為 pool.connect() 取得的連線。
 *
 *   upsertPartsCatalog(client, rows)
 *     parts_catalog 專用，ON CONFLICT (part_number) DO UPDATE。
 *
 * 主要被 routes/upload.js 於 Excel 解析完成後呼叫。
 */
const batchInsert = async (client, table, cols, rows) => {
  let total = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i+BATCH);
    const values = [];
    const ph = batch.map((row, ri) =>
      '(' + cols.map((col, ci) => { values.push(row[col]??null); return `$${ri*cols.length+ci+1}`; }).join(',') + ')'
    );
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph.join(',')}`, values);
    total += batch.length;
  }
  return total;
};

const upsertPartsCatalog = async (client, rows) => {
  let count = 0;
  for (let i = 0; i < rows.length; i += 200) {
    for (const r of rows.slice(i, i+200)) {
      await client.query(`
        INSERT INTO parts_catalog (part_number,part_name,part_category,part_type,category_code,function_code,branch,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT (part_number) DO UPDATE SET
          part_name=EXCLUDED.part_name,part_category=EXCLUDED.part_category,
          part_type=EXCLUDED.part_type,category_code=EXCLUDED.category_code,
          function_code=EXCLUDED.function_code,branch=EXCLUDED.branch,updated_at=NOW()
      `, [r.part_number,r.part_name,r.part_category,r.part_type,r.category_code,r.function_code,r.branch]);
      count++;
    }
  }
  return count;
};

module.exports = { batchInsert, upsertPartsCatalog };
