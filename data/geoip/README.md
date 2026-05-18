# GeoIP Database

世界地图主界面（`/`）需要 MaxMind GeoLite2-City `.mmdb` 数据库来把 VPS 的 IP 解析到经纬度。

## 下载步骤

1. 注册免费账号：https://www.maxmind.com/en/geolite2/signup
2. 登录后下载 **GeoLite2-City** (Binary / .mmdb 格式)
3. 解压，把 `GeoLite2-City.mmdb` 放到本目录：
   ```
   data/geoip/GeoLite2-City.mmdb
   ```
4. 重启后端（`npm start`）

## 缺失时的行为

如果 `.mmdb` 文件不存在：
- 后端 `/api/geo/hosts` 返回 503
- 前端主页地图正常显示，但所有主机进 `unresolved` 列表
- 顶部 banner 提示用户来这里下载
