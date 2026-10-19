# High-level editable design commands

All visual commands require a stable `key`, an explicit binding, and optional `parentId`. Root x/y default to 0. IDs are mapped via node plugin data within the chosen parent, not by display name. Changing parent or key means a new logical object. Repeating the same type/key/parent updates nodes in place; changing node kind for a key fails before replacing it. Results return `{key,id,path,type}` references. Obsolete managed children are hidden for undo; arbitrary user layers are preserved. Templates are editable native nodes, not screenshots.

## Tokens and foundations

Shared `tokens` overrides merge into defaults:

```json
{"colors":{"surface":"#ffffff","surfaceAlt":"#f4f7fb","text":"#202c3a","muted":"#657487","border":"#dfe6ef","accent":"#377bda","positive":"#21865e","chart2":"#36a8a0","chart3":"#e9aa49"},"spacing":{"small":8,"medium":16,"large":24},"typography":{"fontFamily":"Inter","fontStyle":"Regular","label":12,"value":30,"title":16}}
```

`create-variable-collection`: requires file scope; fields `name`, `mode`, `tokens`. Creates/finds the named collection and variables `colors/*` (COLOR), spacing/sizes (FLOAT), font family/style (STRING). Repeated calls reuse IDs. Pass returned `id` as `tokenCollectionId` on visual commands to bind supported color paints to real variables. Other typography/spacing values are applied as shared configuration, not all Figma fields support variable binding. Build component/variable foundations before filling data.

`create-component`: fields `key`, `name`, `width`, `height`, optional `title`, `children` (FRAME/COMPONENT/RECTANGLE/ELLIPSE/TEXT/VECTOR specs, each with a unique stable key), `items` (high-level visual child commands), `tokens`, `tokenCollectionId`. Produces native COMPONENT; instantiate through build-section INSTANCE specs.

`apply-auto-layout`: `nodeId`, `direction` HORIZONTAL/VERTICAL, `gap`, uniform `padding`, `primaryAxisSizingMode`, `counterAxisSizingMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`. Applies to frames/components, returns id/path; undo restores the prior layout.

## Visual commands

| Command | Main fields |
|---|---|
| create-panel | title, items (each a high-level command with stable key), optional native children |
| create-kpi-card | label, value, unit, detail; default 360 × 132 |
| create-line-chart | title, labels[], series:[{key,name,values[],color?}], min/max optional; bounded labels, grid and editable vector paths |
| create-donut-chart | title, slices:[{key,label,value,color?}], innerRatio; editable vector sectors and legend |
| create-digital-twin-map | title, buildings:[{key,name,x,y,width,height,status}], regions:[{key,name,path,color}]; schematic map, buildings use normalized coordinates |

Default general canvas size 360 × 220. Charts require enough room for labels/legends; increase height for many donut slices. Line charts support up to 500 points per series and 20 series; maps up to 300 buildings. The map does not fetch basemaps, infer real geography, or create a 3D scene. Region paths use local coordinates with the Figma-supported absolute M/L/C/Q/Z subset; convert arcs to cubic curves first. Generated donuts use cubic segments.

## Representative dashboard

```json
{"type":"create-panel","key":"operations","title":"园区运营","width":960,"height":600,"idempotencyKey":"operations-initial","items":[
 {"type":"create-kpi-card","key":"energy","label":"今日用电","value":"128","unit":"MWh","x":16,"y":56,"width":280},
 {"type":"create-kpi-card","key":"events","label":"待处理事件","value":"8","x":320,"y":56,"width":280},
 {"type":"create-line-chart","key":"trend","title":"用电趋势","x":16,"y":220,"width":600,"height":260,"labels":["10/01","10/02","10/03"],"series":[{"key":"energy","name":"用电","values":[10,20,15]}]},
 {"type":"create-donut-chart","key":"ratio","title":"能耗占比","x":640,"y":220,"width":300,"height":260,"slices":[{"key":"production","label":"生产","value":70},{"key":"office","label":"办公","value":30}]}
]}
```

To update, resend the same logical keys with new data and a **new** idempotencyKey. Existing node IDs remain; only changed properties appear in diff. For the smallest update, use returned node ID in update-node. Use dry-run first, then validate-layout and screenshot review. The supplied runtime test asserts a changed KPI updates only a small subset of nodes while retaining all IDs.

## 0.8.0 布局扩展

apply-auto-layout 新增 props（统一属性白名单）与 childLayouts:[{nodeId,props}]，后者只接受直接子节点。可通过 props 配置换行、Grid、尺寸模式与约束。Grid 不套用仅适用于横/纵布局的默认轴参数。详情见 docs/EXPANDED-API.md。
