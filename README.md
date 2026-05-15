# 认证项目多场所地图

基于 `/Users/lihaoning/Downloads/认证项目多场所一览表（gpt版）-1.docx` 生成的静态网页项目。

## 本地运行

```bash
npm install
npm run build:data
npm run dev
```

当前本地地址：

```text
http://localhost:5173/
```

## 数据产物

- `public/data/projects.json`: 网页读取的前端数据库。
- `public/data/china-map.json`: 预投影后的中国省市线框地图，不依赖在线瓦片底图。
- `data/projects.sqlite`: 本地 SQLite 数据库，含 `projects`、`cities`、`project_search` 三张表。
- `data/projects.csv`: 可用 Excel 打开的清洗结果。

当前 Word 文件标题为“认证项目多场所一览表（417）”，实际抽取项目数为 417；不是 471。坐标采用地级行政区或区县行政中心点，不是门牌级精确经纬度。

## GitHub Pages 部署

项目已经配置 `.github/workflows/deploy-pages.yml`。推送到 GitHub 仓库的 `main` 分支后，在仓库 Settings -> Pages 中选择 GitHub Actions，工作流会自动发布到 `github.io`。

如果你要手动创建仓库并推送：

```bash
git init
git add .
git commit -m "Create certification project map"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

如果仓库名是 `<你的用户名>.github.io`，访问地址就是 `https://<你的用户名>.github.io/`；如果是普通仓库，访问地址通常是 `https://<你的用户名>.github.io/<仓库名>/`。

## Vercel 免费域名部署

Vercel 可生成免费的 `*.vercel.app` 域名。当前项目已含 `vercel.json`，登录后在项目目录执行：

```bash
npx vercel login
npx vercel --prod
```

也可以把整个 `cert-project-map` 文件夹上传到 GitHub 后，在 Vercel 里 Import Project，保留默认 Vite 配置即可。

## 数据来源

- 项目清单：本地 Word 文件。
- 行政区坐标：`city-geo` 的 `data.json`。
- 中国省市边界与图木舒克市补充坐标：GeoJSON.CN 中国行政区划数据。
