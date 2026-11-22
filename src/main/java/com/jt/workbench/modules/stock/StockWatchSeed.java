package com.jt.workbench.modules.stock;

import com.jt.workbench.modules.stock.entity.StockWatch;
import com.jt.workbench.modules.stock.repo.StockWatchRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 自选股/持仓监控种子数据（来源：参考持仓监控页面）。
 * 仅在 stock_watch 表为空时初始化，不覆盖已有数据。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class StockWatchSeed implements ApplicationRunner {

    private final StockWatchRepository stockWatchRepository;

    @Override
    public void run(ApplicationArguments args) {
        try {
            if (stockWatchRepository.count() > 0) {
                return;
            }
            List<StockWatch> list = buildSeeds();
            stockWatchRepository.saveAll(list);
            log.info("seeded {} stock watch records", list.size());
        } catch (Exception e) {
            log.warn("seed stock watch records skipped: {}", e.getMessage());
        }
    }

    private List<StockWatch> buildSeeds() {
        List<StockWatch> list = new ArrayList<>();
        list.add(seed("齐翔腾达", "sz002408", 4.87, 5.5, 4.5, 10.0, 15.0, 0.16, "2026-03-05"));
        list.add(seed("振华新材", "sh688707", 14.26, 13.0, 8.0, 20.0, 20.0, 0.69, "2026-03-05"));
        list.add(seed("天康生物", "sz002100", 7.4, 7.0, 6.0, 10.0, 20.0, -1.29, "2026-03-05"));
        list.add(seed("海南橡胶", "sh601118", 5.61, 6.0, 4.5, 10.0, 20.0, -5.52, "2026-03-05"));
        list.add(seed("钢研高纳", "sz300034", 22.45, 20.0, 10.0, 30.0, 35.0, -3.9, "2026-03-05"));
        list.add(seed("国泰集团", "sh603977", 13.84, 13.0, 11.5, 18.0, 20.0, -0.84, "2026-03-05"));
        list.add(seed("凯龙股份", "sz002783", 9.5, 9.0, 7.5, 15.0, 15.0, 0.2, "2026-03-05"));
        list.add(seed("中钢国际", "sz000928", 6.43, 6.75, 5.5, 10.0, 13.0, 0.13999999999999999, "2026-03-05"));
        list.add(seed("安 纳 达", "sz002136", 12.26, 12.0, 10.0, 20.0, null, 2.6100000000000003, "2026-03-05"));
        list.add(seed("双环科技", "sz000707", 6.18, 6.15, 6.0, 10.0, 15.0, 0.89, "2026-03-05"));
        list.add(seed("中化国际", "sh600500", 3.92, 4.0, 3.8, 7.0, 15.0, -0.2, "2026-03-05"));
        list.add(seed("四川美丰", "sz000731", 6.59, 7.2, 5.5, 10.0, 10.0, 2.39, "2026-03-05"));
        list.add(seed("中国中冶", "sh601618", 2.97, 3.15, 3.14, 5.5, 6.0, 0.61, "2026-03-05"));
        list.add(seed("雪峰科技", "sh603227", 8.39, 7.5, 7.5, 12.0, 15.0, 1.22, "2026-03-05"));
        list.add(seed("中粮科工", "sz301058", 10.99, 10.0, 10.0, 20.0, 20.0, 0.65, "2026-01-02"));
        list.add(seed("贵研铂业", "sh600459", 19.2, 18.5, 12.0, 25.0, 36.0, -2.59, "2026-01-02"));
        list.add(seed("恒邦股份", "sz002237", 13.8, 12.0, 9.0, 18.0, 22.0, -3.06, "2026-01-02"));
        list.add(seed("泰山石油", "sz000554", 6.56, 6.5, 6.0, 20.0, 20.0, -3.0300000000000002, "2026-01-13"));
        list.add(seed("中盐化工", "sh600328", 8.23, 8.0, 7.5, null, null, -2.59, null));
        list.add(seed("岳阳林纸", "sh600963", 4.7, 4.0, 3.5, null, null, -4.130000000000001, null));
        list.add(seed("华阳股份", "sh600348", 8.24, 6.4, 6.0, 12.0, null, -1.17, "2026-02-05"));
        list.add(seed("湖南海利", "sh603639", 6.84, 6.0, 5.5, 10.0, null, 0.13, "2026-02-05"));
        list.add(seed("安迪苏", "sh600299", 8.98, 9.0, 8.0, 15.0, null, 7.739999999999999, "2026-01-26"));
        list.add(seed("河钢资源", "sz000923", null, 13.5, 13.5, 25.0, 25.0, null, null));
        list.add(seed("海油工程", "sh600583", null, 5.0, 4.5, 7.5, 7.5, null, null));
        list.add(seed("中国铝业", "sh601600", null, 6.5, 6.5, 10.0, 10.0, null, null));
        list.add(seed("天富能源", "sh600509", null, 5.5, 5.5, 10.0, 10.0, null, null));
        list.add(seed("昊华科技", "sh600378", null, 23.0, 23.0, 43.0, 43.0, null, null));
        list.add(seed("钒钛股份", "sz000629", null, 2.4, 2.2, 5.0, 6.0, null, null));
        list.add(seed("中信金属", "sh601061", null, 7.0, 7.0, 14.0, 14.0, null, null));
        list.add(seed("东华科技", "sz002140", null, 7.5, 7.5, 15.0, 15.0, null, null));
        list.add(seed("沧州大化", "sh600230", null, 10.0, 9.0, 20.0, 20.0, null, null));
        list.add(seed("南钢股份", "sh600282", null, 4.0, 3.3, 5.5, 6.0, null, null));
        list.add(seed("利尔化学", "sz002258", null, 8.0, 8.0, 15.0, 15.0, null, null));
        list.add(seed("鲁西化工", "sz000830", null, 9.0, 9.0, 18.0, 18.0, null, null));
        list.add(seed("杭氧股份", "sz002430", null, 16.0, 15.0, 35.0, 35.0, null, null));
        list.add(seed("扬农化工", "sh600486", null, 45.0, 45.0, 90.0, 90.0, null, null));
        list.add(seed("金钼股份", "sh601958", null, 10.0, 6.0, 20.0, 20.0, null, null));
        list.add(seed("锡业股份", "sz000960", null, 14.0, 8.0, 25.0, 25.0, null, null));
        list.add(seed("东方钽业", "sz000962", null, 8.0, 12.0, 20.0, 24.0, null, null));
        list.add(seed("华鲁恒升", "sh600426", null, 20.0, 15.0, 40.0, 40.0, null, null));
        list.add(seed("宝光股份", "sh600379", null, 7.0, 6.0, 20.0, 20.0, null, null));
        list.add(seed("宝钛股份", "sh600456", null, 17.0, 16.0, 34.0, 34.0, null, null));
        list.add(seed("株冶集团", "sh600961", null, 7.5, 7.5, 13.0, 13.0, null, null));
        list.add(seed("ST应急", "sz300527", null, 7.5, 4.0, 12.0, 13.0, null, null));
        list.add(seed("华锡有色", "sh600301", null, 14.0, 14.0, 25.0, 30.0, null, null));
        list.add(seed("金天钛业", "sh688750", null, 8.0, 8.0, null, null, null, null));
        list.add(seed("厦门钨业", "sh600549", null, null, 12.0, null, 36.0, null, null));
        list.add(seed("盛和资源", "sh600392", null, null, 7.0, null, 21.0, null, null));
        list.add(seed("北方稀土", "sh600111", null, null, 10.0, null, 30.0, null, null));
        list.add(seed("中粮糖业", "sh600737", null, null, 6.0, null, 18.0, null, null));
        list.add(seed("中钢天源", "sz002057", null, 7.0, 6.0, 15.0, 18.0, null, null));
        list.add(seed("北元集团", "sh601568", null, 4.0, 3.5, null, 8.0, null, null));
        list.add(seed("航发控制", "sz000738", null, 15.0, null, null, null, null, null));
        list.add(seed("中泰化学", "sz002092", null, 4.0, null, null, null, null, null));
        list.add(seed("中钨高新", "sz000657", null, 6.0, null, 18.0, null, null, null));
        list.add(seed("辉隆股份", "sz002556", null, 5.3, 4.3, 8.0, null, null, null));
        list.add(seed("安琪酵母", "sh600298", null, 36.0, null, 55.0, null, null, null));
        list.add(seed("中农立华", "sh603970", null, 11.0, null, 18.0, null, null, null));
        list.add(seed("氯碱化工", "sh600618", null, 9.0, null, 18.0, null, null, null));
        list.add(seed("中密控股", "sz300470", null, 34.0, 30.0, 60.0, null, null, null));
        list.add(seed("耀皮玻璃", "sh600819", null, 5.0, null, 8.0, null, null, null));
        list.add(seed("中复神鹰", "sh688295", null, 18.0, 17.0, 36.0, null, null, null));
        list.add(seed("三友化工", "sh600409", null, 6.0, 5.5, null, null, null, null));
        list.add(seed("中牧股份", "sh600195", null, 7.4, 7.4, 20.0, 20.0, null, "2026-03-27"));
        list.add(seed("岳阳兴长", "sz000819", null, 14.0, null, 30.0, 30.0, null, null));
        return list;
    }

    private StockWatch seed(String name, String code, Double yearInit, Double entry, Double heavy,
                            Double tp1, Double tp2, Double prevChg, String updDate) {
        StockWatch s = new StockWatch();
        s.setName(name);
        s.setCode(code);
        s.setYearInit(yearInit);
        s.setEntryPrice(entry);
        s.setHeavyPrice(heavy);
        s.setTp1(tp1);
        s.setTp2(tp2);
        s.setPrevChg(prevChg);
        s.setUpdDate(updDate);
        s.setEnabled(true);
        return s;
    }
}
