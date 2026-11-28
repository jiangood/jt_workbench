package com.jt.workbench.modules.music.controller;

import com.jt.workbench.modules.music.entity.Music;
import com.jt.workbench.modules.music.repo.MusicRepository;
import io.github.jiangood.openadmin.framework.perm.HasPermission;
import io.github.jiangood.openadmin.framework.spi.FileOperator;
import io.github.jiangood.openadmin.util.dto.AjaxResult;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.InputStream;
import java.net.URI;
import java.time.Duration;
import java.util.List;

/**
 * 音乐库：列表（关键字 / 艺术家过滤）、元信息维护、收藏与删除。
 * 音频文件本身由任务写入对象存储，这里只管理元信息。
 */
@Slf4j
@RestController
@RequestMapping("admin/music")
public class MusicController {

    @Autowired
    private MusicRepository musicRepository;

    @Autowired
    private FileOperator fileOperator;

    @HasPermission("music:read")
    @PostMapping("list")
    public AjaxResult list(@RequestParam(required = false) String artist,
                           @RequestParam(required = false) String keyword) {
        List<Music> list = musicRepository.search(blankToNull(keyword), blankToNull(artist), Sort.by("title"));
        return new AjaxResult().ok().data(list);
    }

    @HasPermission("music:read")
    @GetMapping("info/{id}")
    public AjaxResult info(@PathVariable String id) {
        Music item = musicRepository.findById(id).orElse(null);
        return item != null ? new AjaxResult().ok().data(item) : new AjaxResult();
    }

    @HasPermission("music:edit")
    @PostMapping("create")
    public AjaxResult create(@RequestBody Music input) {
        return new AjaxResult().ok().data(musicRepository.save(input));
    }

    @HasPermission("music:edit")
    @PostMapping("update")
    public AjaxResult update(@RequestBody Music input) {
        Music old = musicRepository.findById(input.getId()).orElse(null);
        if (old != null) {
            if (input.getTitle() != null) old.setTitle(input.getTitle());
            if (input.getArtist() != null) old.setArtist(input.getArtist());
            if (input.getAlbum() != null) old.setAlbum(input.getAlbum());
            if (input.getCoverUrl() != null) old.setCoverUrl(input.getCoverUrl());
            if (input.getPlayCount() != null) old.setPlayCount(input.getPlayCount());
            if (input.getDuration() != null) old.setDuration(input.getDuration());
            musicRepository.save(old);
        }
        return new AjaxResult();
    }

    @HasPermission("music:edit")
    @PostMapping("delete")
    public AjaxResult delete(@RequestBody io.github.jiangood.openadmin.util.dto.IdReq req) {
        musicRepository.deleteById(req.getId());
        return new AjaxResult();
    }

    /** 艺术家下拉候选 */
    @HasPermission("music:read")
    @GetMapping("artists")
    public AjaxResult artists() {
        List<String> list = musicRepository.findAll(Sort.by("artist")).stream()
                .map(Music::getArtist)
                .filter(a -> a != null && !a.isBlank())
                .distinct()
                .toList();
        return new AjaxResult().ok().data(list);
    }

    /**
     * 音频播放入口（支持 Range/拖动进度）。
     * 存储支持预签名直链时 302 重定向到对象存储（前端直连 S3/R2，避免服务器带宽与内存开销），
     * 否则回退为由服务端代理流（LOCAL 等场景）。
     */
    @HasPermission("music:read")
    @GetMapping("audio/{id}")
    public ResponseEntity<byte[]> audio(@PathVariable String id,
                                         @RequestHeader(value = "Range", required = false) String range) {
        Music item = musicRepository.findById(id).orElse(null);
        if (item == null || item.getFilePath() == null || item.getFilePath().isBlank()) {
            return ResponseEntity.notFound().build();
        }
        String key = item.getFilePath();
        // 方案 A：S3/R2 等支持预签名 GET 时，鉴权后重定向到直链，浏览器直连对象存储（含 Range/seek）
        if (fileOperator.supportsPresignedGet()) {
            try {
                String url = fileOperator.presignGetUrl(key, Duration.ofHours(6));
                if (url != null && !url.isBlank()) {
                    return ResponseEntity.status(HttpStatus.FOUND).location(URI.create(url)).build();
                }
            } catch (Exception e) {
                log.warn("生成音频直链失败，回退服务端代理: key={}", key, e);
            }
        }
        try (InputStream in = fileOperator.getFileStream(key)) {
            byte[] all = in.readAllBytes();
            MediaType type = audioType(item.getFormat());
            if (range == null || !range.startsWith("bytes=")) {
                return ResponseEntity.ok().contentType(type)
                        .header(HttpHeaders.ACCEPT_RANGES, "bytes").body(all);
            }
            String spec = range.substring(6);
            String[] parts = spec.split("-", 2);
            long start = parts[0].isBlank() ? 0 : Long.parseLong(parts[0]);
            long end = parts.length < 2 || parts[1].isBlank()
                    ? all.length - 1 : Math.min(Long.parseLong(parts[1]), all.length - 1);
            if (start >= all.length || end < start) {
                return ResponseEntity.status(416)
                        .header(HttpHeaders.CONTENT_RANGE, "bytes */" + all.length).build();
            }
            byte[] slice = java.util.Arrays.copyOfRange(all, (int) start, (int) end + 1);
            return ResponseEntity.status(206).contentType(type)
                    .header(HttpHeaders.CONTENT_RANGE, "bytes " + start + "-" + end + "/" + all.length)
                    .header(HttpHeaders.ACCEPT_RANGES, "bytes").body(slice);
        } catch (Exception e) {
            return ResponseEntity.notFound().build();
        }
    }

    private static MediaType audioType(String format) {
        String f = format == null ? "" : format.toLowerCase();
        return switch (f) {
            case "m4a" -> MediaType.parseMediaType("audio/mp4");
            case "flac" -> MediaType.parseMediaType("audio/flac");
            case "wav" -> MediaType.parseMediaType("audio/wav");
            case "ogg" -> MediaType.parseMediaType("audio/ogg");
            default -> MediaType.parseMediaType("audio/mpeg"); // mp3 及未知格式兜底
        };
    }

    private static String blankToNull(String v) {
        return v == null || v.isBlank() ? null : v.trim();
    }
}
