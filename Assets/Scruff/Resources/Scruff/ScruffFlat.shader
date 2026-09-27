// Scruff/Flat
// The one shader almost everything in Scruff renders with.
// Flat-shaded, vertex-coloured, per-vertex lit from global values that DayNightCycle sets.
// Cheap on Quest, works in the Built-in pipeline and in URP (as an unlit-style pass), supports
// single-pass instanced stereo.
//
// Vertex colour alpha encodes emission (so meshes without vertex colours, alpha = 1, are not emissive):
//   a = 1          -> no glow
//   a in [0.5, 1)  -> glows at night only, strength (1 - a) * 2
//   a in [0, 0.5)  -> always glows (unlit), strength (0.5 - a) * 2. UI uses this so it stays readable at night.
Shader "Scruff/Flat"
{
    Properties
    {
        _Color ("Tint", Color) = (1,1,1,1)
        _Highlight ("Highlight (rgb colour, a amount)", Color) = (1,1,1,0)
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        LOD 100

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #include "UnityCG.cginc"

            float4 _ScruffLightDir;       // xyz: direction towards the sun/moon, world space
            float4 _ScruffLightColor;     // rgb
            float4 _ScruffAmbientSky;     // rgb
            float4 _ScruffAmbientGround;  // rgb
            float4 _ScruffFogColor;       // rgb
            float4 _ScruffFogParams;      // x: start distance, y: end distance, z: max fog amount
            float _ScruffNightGlow;       // 0 during the day, 1 at night
            float4 _ScruffIndoorMin0;     // two axis-aligned "indoor" boxes that get room lighting at night
            float4 _ScruffIndoorMax0;
            float4 _ScruffIndoorMin1;
            float4 _ScruffIndoorMax1;
            float4 _ScruffIndoorLight;    // rgb: minimum lighting inside those boxes

            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(fixed4, _Color)
                UNITY_DEFINE_INSTANCED_PROP(fixed4, _Highlight)
            UNITY_INSTANCING_BUFFER_END(Props)

            struct appdata
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;
                float4 color : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct v2f
            {
                float4 pos : SV_POSITION;
                half3 color : COLOR;
                half fog : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            v2f vert (appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_OUTPUT(v2f, o);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);

                float3 worldPos = mul(unity_ObjectToWorld, v.vertex).xyz;
                float3 n = UnityObjectToWorldNormal(v.normal);
                float3 l = normalize(_ScruffLightDir.xyz + float3(0.0, 0.0001, 0.0));
                float ndl = saturate(dot(n, l));
                float hemi = n.y * 0.5 + 0.5;
                float3 ambient = lerp(_ScruffAmbientGround.rgb, _ScruffAmbientSky.rgb, hemi);
                float3 lighting = ambient + _ScruffLightColor.rgb * ndl;

                float3 in0 = step(_ScruffIndoorMin0.xyz, worldPos) * step(worldPos, _ScruffIndoorMax0.xyz);
                float3 in1 = step(_ScruffIndoorMin1.xyz, worldPos) * step(worldPos, _ScruffIndoorMax1.xyz);
                float indoor = saturate(in0.x * in0.y * in0.z + in1.x * in1.y * in1.z);
                float3 room = _ScruffIndoorLight.rgb * (0.7 + 0.3 * hemi) + _ScruffIndoorLight.rgb * 0.25 * saturate(dot(n, float3(0.3, 0.8, 0.5)));
                lighting = lerp(lighting, max(lighting, room), indoor);

                fixed4 tint = UNITY_ACCESS_INSTANCED_PROP(Props, _Color);
                fixed4 hl = UNITY_ACCESS_INSTANCED_PROP(Props, _Highlight);
                float3 albedo = v.color.rgb * tint.rgb;

                float e = 1.0 - v.color.a;
                float always = saturate((e - 0.5) * 2.0);
                float night = (e <= 0.5 ? e * 2.0 : 0.0) * _ScruffNightGlow;
                float glow = max(always, night);

                float3 col = albedo * lerp(lighting, float3(1.0, 1.0, 1.0), glow);

                float3 toCam = normalize(_WorldSpaceCameraPos - worldPos);
                float rim = 1.0 - saturate(dot(n, toCam));
                col = lerp(col, hl.rgb, hl.a * (0.4 + 0.6 * rim));

                float dist = distance(worldPos, _WorldSpaceCameraPos);
                o.fog = saturate((dist - _ScruffFogParams.x) / max(0.01, _ScruffFogParams.y - _ScruffFogParams.x)) * _ScruffFogParams.z;
                o.color = col;
                o.pos = UnityObjectToClipPos(v.vertex);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(i);
                return fixed4(lerp(i.color, _ScruffFogColor.rgb, i.fog), 1.0);
            }
            ENDCG
        }
    }
    Fallback Off
}
