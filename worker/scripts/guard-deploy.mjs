// 线上发布只走 GitHub Actions 的 release workflow（发布 release 时触发）。
// 本地不碰生产：这里直接拒绝，避免顺手 `npm run deploy` 把开发中的代码推上线。
if (process.env.CI !== 'true') {
  console.error('拒绝在本地部署：线上发布只允许 GitHub release workflow。');
  console.error('本地请用 `npm run dev`；只想验证构建用 `npm run deploy:dry`。');
  process.exit(1);
}
