package cn.noetic.atlas;

import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.List;
import java.util.Arrays;

/** Only generated cache copies are shared; the live database is never exposed. */
@CapacitorPlugin(name = "LearningFileShare")
public class LearningFileSharePlugin extends Plugin {
    private static final List<String> ALLOWED_MIME = Arrays.asList(
        "application/pdf", "application/json", "text/markdown", "text/plain",
        "application/vnd.sqlite3", "application/x-sqlite3", "application/octet-stream"
    );

    @PluginMethod
    public void share(PluginCall call) {
        try {
            String rawUri = call.getString("uri", "");
            String mime = call.getString("mimeType", "application/octet-stream");
            Uri parsed = Uri.parse(rawUri);
            if (!"file".equals(parsed.getScheme()) || parsed.getPath() == null || !ALLOWED_MIME.contains(mime)) {
                call.reject("不支持的导出文件或格式"); return;
            }
            File root = new File(getContext().getCacheDir(), "exports").getCanonicalFile();
            File file = new File(parsed.getPath()).getCanonicalFile();
            if (!file.getPath().startsWith(root.getPath() + File.separator) || !file.isFile()) {
                call.reject("只允许分享学习站生成的缓存副本"); return;
            }
            Uri content = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, content);
            send.putExtra(Intent.EXTRA_SUBJECT, call.getString("title", file.getName()));
            send.setClipData(ClipData.newRawUri(file.getName(), content));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(send, "保存或分享导出文件"));
            // Resolving means the chooser opened, not that a recipient saved it.
            call.resolve();
        } catch (Exception exception) {
            call.reject("无法打开系统分享面板", exception);
        }
    }
}
