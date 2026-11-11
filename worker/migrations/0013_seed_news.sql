-- 首次初始化：16 个订阅源 + 每源一行 rss_fetch 任务 + 默认屏蔽词。
-- 由迁移保证「每个库只执行一次」（取代原来的手工 seed 脚本）；
-- 内容为幂等写法，已初始化过的库执行到这里不会产生重复数据。
INSERT OR IGNORE INTO news_source (id, name, type, url, category, sort) VALUES
  ('wb-src-hacker-news',  'Hacker News',       'RSS', 'https://hnrss.org/frontpage',              '技术社区', 10),
  ('wb-src-infoq-cn',     'InfoQ 中文',        'RSS', 'https://www.infoq.cn/feed',                '技术媒体', 20),
  ('wb-src-36kr',         '36Kr',              'RSS', 'https://www.36kr.com/feed',                '科技商业', 30),
  ('wb-src-sspai',        '少数派',            'RSS', 'https://sspai.com/feed',                   '数字生活', 40),
  ('wb-src-v2ex',         'V2EX',              'RSS', 'https://www.v2ex.com/index.xml',           '技术社区', 50),
  ('wb-src-ruanyf',       '阮一峰的网络日志',  'RSS', 'https://www.ruanyifeng.com/blog/atom.xml', '个人博客', 60),
  ('wb-src-cloudflare',   'Cloudflare Blog',   'RSS', 'https://blog.cloudflare.com/rss/',         '云与网络', 70),
  ('wb-src-github',       'GitHub Blog',       'RSS', 'https://github.blog/feed/',                '开源', 80),
  ('wb-src-solidot',      'Solidot',           'RSS', 'https://www.solidot.org/index.rss',        '科技媒体', 90),
  ('wb-src-cnblogs',      '博客园',            'RSS', 'https://www.cnblogs.com/rss',              '技术社区', 100),
  ('wb-src-ithome',       'IT之家',            'RSS', 'https://www.ithome.com/rss/',              '科技媒体', 110),
  ('wb-src-meituan',      '美团技术团队',      'RSS', 'https://tech.meituan.com/feed/',           '技术团队', 120),
  ('wb-src-wallstreetcn', '华尔街见闻',        'RSS', 'https://feed.wallstreetcn.com/',           '财经快讯', 130),
  ('wb-src-jiemian',      '界面新闻',          'RSS', 'https://a.jiemian.com/index.php?m=article&a=rss', '商业财经', 140),
  ('wb-src-tmtpost',      '钛媒体',            'RSS', 'https://www.tmtpost.com/rss.xml',          '科技商业', 150),
  ('wb-src-marketwatch',  'MarketWatch',       'RSS', 'http://feeds.marketwatch.com/marketwatch/topstories/', '海外财经', 160);

-- 任务：按源一行（v4 映射「IT资讯-抓取」），next_run_at=1 立即到期，首次 poll 逐源领取
INSERT OR IGNORE INTO job (type, payload, cron, enabled, status, next_run_at)
SELECT 'rss_fetch', json_object('sourceId', s.id, 'url', s.url), '0 0 */2 * * ?', s.enabled, 'pending', 1
FROM news_source s
WHERE NOT EXISTS (SELECT 1 FROM job j WHERE j.type = 'rss_fetch' AND j.payload LIKE '%' || s.id || '%');

-- 默认屏蔽词（全局），仅空表时写入
INSERT OR IGNORE INTO news_block_word (keyword, source_id)
SELECT column1, '' FROM (VALUES
  ('广告'),('推广'),('软文'),('赞助'),('商务合作'),('招商'),('加盟'),
  ('优惠券'),('领券'),('秒杀'),('团购'),('返利'),('抽奖'),('带货'),
  ('限时特惠'),('打折促销'),('清仓甩卖'),('代购'),
  ('sponsored'),('promoted'),('advertisement')
)
WHERE NOT EXISTS (SELECT 1 FROM news_block_word LIMIT 1);
