package com.jt.workbench.modules.exchange.controller;

import com.jt.workbench.modules.exchange.service.ExchangeRateService;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("admin/exchange")
public class ExchangeRateController {

    private final ExchangeRateService exchangeRateService;

    public ExchangeRateController(ExchangeRateService exchangeRateService) {
        this.exchangeRateService = exchangeRateService;
    }

    /** 首页美元兑人民币趋势，range 支持 1m / 3m / 6m / 1y，默认 3m。 */
    @GetMapping("usd-cny")
    public AjaxResult usdCny(@RequestParam(defaultValue = "3m") String range) {
        return new AjaxResult().ok().data(exchangeRateService.usdCny(range));
    }
}
