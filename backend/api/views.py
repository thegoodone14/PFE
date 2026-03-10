from rest_framework.views import APIView
from rest_framework.response import Response
from .services import MobilityService
from .tomtom_service import PedestrianTomTomService

class ItinerarySearch(APIView):
    """
    POST /api/search/
    JSON Body: { "start": "2.34;48.85", "end": "2.29;48.87" }
    """
    def post(self, request):
        start = request.data.get('start')
        end = request.data.get('end')

        if not start or not end:
            return Response({"error": "Paramètres 'start' et 'end' requis"}, status=400)

        service = MobilityService()
        result = service.calculate_safe_route(start, end)
        
        return Response(result)
    
class PedestrianSearch(APIView):
    """
    POST /api/pedestrian/
    JSON Body: { "start": "2.3488;48.8534", "end": "2.2950;48.8737" }
    """
    def post(self, request):
        start = request.data.get('start')
        end = request.data.get('end')

        if not start or not end:
            return Response({"error": "Paramètres 'start' et 'end' requis"}, status=400)

        service = PedestrianTomTomService()
        result = service.calculate_pedestrian_safe_routes(start, end)
        
        return Response(result)