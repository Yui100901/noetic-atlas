package cn.noetic.atlas;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LearningFileSharePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
