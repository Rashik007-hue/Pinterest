from flask import Flask, request, jsonify
import requests
import re

app = Flask(__name__)

@app.route('/api/search', methods=['GET'])
def search_pinterest():
    # ইউজার থেকে সার্চ কুয়েরি (Keyword) নেওয়া
    query = request.args.get('q')
    if not query:
        return jsonify({
            "status": False, 
            "error": "Query parameter 'q' is required. Example: /api/search?q=flower"
        }), 400
    
    # URL এর জন্য স্পেসগুলোকে %20 দিয়ে রিপ্লেস করা
    formatted_query = query.replace(' ', '%20')
    url = f"https://www.pinterest.com/search/pins/?q={formatted_query}"
    
    # Pinterest যাতে বট ভেবে ব্লক না করে, তার জন্য ব্রাউজারের হেডার ব্যবহার করা হলো
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        
        # রেগুলার এক্সপ্রেশন (Regex) ব্যবহার করে পেজের সোর্স থেকে হাই-কোয়ালিটি (736x) ছবির লিংকগুলো বের করা
        pattern = r'https://i\.pinimg\.com/736x/[a-zA-Z0-9/_-]+\.(?:jpg|png|webp)'
        matches = re.findall(pattern, response.text)
        
        # ডুপ্লিকেট লিংকগুলো রিমুভ করা (অর্ডার ঠিক রেখে)
        seen = set()
        unique_images = []
        for img in matches:
            if img not in seen:
                seen.add(img)
                unique_images.append(img)
        
        return jsonify({
            "status": True,
            "query": query,
            "total_results": len(unique_images),
            "images": unique_images
        }), 200
        
    except requests.exceptions.RequestException as e:
        return jsonify({
            "status": False, 
            "error": f"Failed to fetch data from Pinterest: {str(e)}"
        }), 500

@app.route('/', methods=['GET'])
def home():
    return jsonify({
        "status": True,
        "message": "Pinterest Search API is running perfectly! Use /api/search?q=your_keyword"
    })

# Vercel-এর জন্য app অবজেক্টটি ডিফল্টভাবে এক্সপোজড থাকতে হয়।
