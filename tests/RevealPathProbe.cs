// Test the real native path resolver without opening Explorer during automated tests.
using System;
using System.Reflection;
using System.Text;
using System.Web.Script.Serialization;
using XImageSaver;
public static class RevealPathProbe {
    public static void Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        try {
            var method = typeof(Program).GetMethod("ResolveSavedLocation", BindingFlags.Static | BindingFlags.NonPublic);
            object location = method.Invoke(null, new object[] { args[0] });
            Type type = location.GetType();
            Console.Write(json.Serialize(new {
                ok = true,
                path = type.GetField("Path").GetValue(location),
                folderPath = type.GetField("FolderPath").GetValue(location),
                selectFile = type.GetField("SelectFile").GetValue(location)
            }));
        } catch (Exception error) {
            Console.Write(json.Serialize(new { ok = false, error = (error.InnerException ?? error).Message }));
        }
    }
}
