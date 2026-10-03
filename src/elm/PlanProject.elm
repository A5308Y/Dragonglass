port module PlanProject exposing (main)

{-| Planning a Project, one step at a time, as David Allen's Natural Planning Model does it:
why it exists, what done looks like, every idea that comes to mind, what each idea becomes
(a Next Action, a Sub-project, possibly after another one, Someday, or nothing), and finally
the branches of the tree that still have no Next Action.

Nothing is written until "Create" on the fourth step; the host writes it all and answers with
the branches still lacking a Next Action (see `src/ui/plan-project.ts`).

-}

import Browser
import Dict
import Gtd.Command.PlanProject as Command exposing (Command)
import Gtd.Data as Data exposing (Project, Snapshot)
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ProjectId)
import Gtd.ProjectStatus as ProjectStatus
import Gtd.Ui as Ui
import Html exposing (Html, button, datalist, div, h2, input, li, ol, option, p, select, span, strong, text, textarea, ul)
import Html.Attributes exposing (class, classList, disabled, id, list, placeholder, rows, selected, value)
import Html.Events exposing (onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Set


port planToHost : Encode.Value -> Cmd msg


port planFromHost : (Decode.Value -> msg) -> Sub msg


type Step
    = PurposeStep
    | OutcomeStep
    | IdeasStep
    | OrganiseStep
    | NextActionsStep


type alias Item =
    { title : String, kind : String, context : String, after : String }


{-| A branch of the tree without a Next Action, and the step being typed for it.
-}
type alias Gap =
    { projectId : ProjectId, title : String, draft : String, context : String }


type Pending
    = Saving
    | Adding ProjectId
    | Ignore


type alias Model =
    { snapshot : Snapshot
    , projectId : ProjectId
    , step : Step
    , purpose : String
    , outcome : String
    , ideas : String
    , items : List Item
    , defaultContext : String
    , gaps : List Gap
    , requests : Requests Pending
    , error : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | GoTo Step
    | PurposeChanged String
    | OutcomeChanged String
    | IdeasChanged String
    | Organise
    | DefaultContextChanged String
    | ItemTitleChanged Int String
    | ItemKindChanged Int String
    | ItemContextChanged Int String
    | ItemAfterChanged Int String
    | Create
    | GapDraftChanged ProjectId String
    | GapContextChanged ProjectId String
    | AddGapAction ProjectId
    | Delegate ProjectId
    | Close


type alias Flags =
    { snapshot : Snapshot, projectId : ProjectId, purpose : String, desiredOutcome : String }


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> planFromHost GotHost
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init raw =
    let
        flags =
            Decode.decodeValue flagsDecoder raw
                |> Result.withDefault { snapshot = Data.empty, projectId = "", purpose = "", desiredOutcome = "" }
    in
    ( { snapshot = flags.snapshot
      , projectId = flags.projectId
      , step = PurposeStep
      , purpose = flags.purpose
      , outcome = flags.desiredOutcome
      , ideas = ""
      , items = []
      , defaultContext = ""
      , gaps = []
      , requests = Host.noRequests
      , error = Nothing
      }
    , Cmd.none
    )


flagsDecoder : Decoder Flags
flagsDecoder =
    Decode.map4 Flags
        (Decode.field "snapshot" Data.snapshotDecoder)
        (Decode.field "projectId" Decode.string)
        (Decode.field "purpose" Decode.string)
        (Decode.field "desiredOutcome" Decode.string)



-- UPDATE


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            case Decode.decodeValue Host.outcomeDecoder value of
                Ok outcome ->
                    let
                        ( pending, requests ) =
                            Host.resolve outcome.requestId model.requests

                        next =
                            { model | requests = requests }
                    in
                    case outcome.result of
                        Err message ->
                            ( { next | error = Just message }, Cmd.none )

                        Ok result ->
                            ( finish (Maybe.withDefault Ignore pending) result { next | error = Nothing }, Cmd.none )

                Err _ ->
                    ( model, Cmd.none )

        GoTo step ->
            ( { model | step = step, error = Nothing }, Cmd.none )

        PurposeChanged purpose ->
            ( { model | purpose = purpose }, Cmd.none )

        OutcomeChanged outcome ->
            ( { model | outcome = outcome }, Cmd.none )

        IdeasChanged ideas ->
            ( { model | ideas = ideas }, Cmd.none )

        Organise ->
            ( { model | step = OrganiseStep, items = itemsFor model, error = Nothing }, Cmd.none )

        DefaultContextChanged context ->
            ( { model
                | defaultContext = context
                , items =
                    List.map
                        (\item ->
                            if item.kind == "action" && (String.isEmpty item.context || item.context == model.defaultContext) then
                                { item | context = context }

                            else
                                item
                        )
                        model.items
              }
            , Cmd.none
            )

        ItemTitleChanged index title ->
            ( updateItem index (\item -> { item | title = title }) model, Cmd.none )

        ItemKindChanged index kind ->
            ( updateItem index
                (\item ->
                    { item
                        | kind = kind
                        , context =
                            if kind == "action" && String.isEmpty item.context then
                                model.defaultContext

                            else
                                item.context
                    }
                )
                model
                |> clearDanglingAfters
            , Cmd.none
            )

        ItemContextChanged index context ->
            ( updateItem index (\item -> { item | context = context }) model, Cmd.none )

        ItemAfterChanged index after ->
            ( updateItem index (\item -> { item | after = after }) model, Cmd.none )

        Create ->
            send Saving
                (Command.SavePlan
                    { projectId = model.projectId
                    , purpose = String.trim model.purpose
                    , desiredOutcome = String.trim model.outcome
                    , items = model.items
                    }
                )
                model

        GapDraftChanged projectId draft ->
            ( updateGap projectId (\gap -> { gap | draft = draft }) model, Cmd.none )

        GapContextChanged projectId context ->
            ( updateGap projectId (\gap -> { gap | context = context }) model, Cmd.none )

        AddGapAction projectId ->
            case List.filter (\gap -> gap.projectId == projectId) model.gaps of
                gap :: _ ->
                    if String.isEmpty (String.trim gap.draft) || String.isEmpty (String.trim gap.context) then
                        ( { model | error = Just "A Next Action needs a title and a context." }, Cmd.none )

                    else
                        send (Adding projectId)
                            (Command.AddAction { projectId = projectId, title = String.trim gap.draft, context = String.trim gap.context })
                            model

                [] ->
                    ( model, Cmd.none )

        Delegate projectId ->
            send Ignore (Command.Delegate projectId) model

        Close ->
            send Ignore Command.Close model


{-| What the host answered: after "Create" and after each added Action, the branches still lacking one.
-}
finish : Pending -> Decode.Value -> Model -> Model
finish pending result model =
    case pending of
        Ignore ->
            model

        _ ->
            case Decode.decodeValue gapsDecoder result of
                Ok gaps ->
                    let
                        previous =
                            Dict.fromList (List.map (\gap -> ( gap.projectId, gap )) model.gaps)
                    in
                    { model
                        | step = NextActionsStep
                        , gaps =
                            List.map
                                (\( projectId, title ) ->
                                    case ( Dict.get projectId previous, pending ) of
                                        ( Just kept, Saving ) ->
                                            kept

                                        ( Just kept, Adding added ) ->
                                            if added == projectId then
                                                { kept | draft = "" }

                                            else
                                                kept

                                        _ ->
                                            { projectId = projectId, title = title, draft = "", context = model.defaultContext }
                                )
                                gaps
                    }

                Err _ ->
                    model


gapsDecoder : Decoder (List ( ProjectId, String ))
gapsDecoder =
    Decode.field "gaps"
        (Decode.list (Decode.map2 Tuple.pair (Decode.field "projectId" Decode.string) (Decode.field "title" Decode.string)))


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests
    in
    ( { model | requests = requests, error = Nothing }, planToHost (Host.envelope requestId (Command.encode command)) )


{-| The ideas as items, keeping what was already decided for an idea that is still there.
-}
itemsFor : Model -> List Item
itemsFor model =
    let
        decided =
            Dict.fromList (List.map (\item -> ( item.title, item )) model.items)
    in
    ideaLines model.ideas
        |> List.map
            (\title ->
                Dict.get title decided
                    |> Maybe.withDefault { title = title, kind = "action", context = model.defaultContext, after = "" }
            )
        |> (\items -> { model | items = items } |> clearDanglingAfters |> .items)


ideaLines : String -> List String
ideaLines text =
    String.lines text
        |> List.map (stripBullet >> String.trim)
        |> List.filter (not << String.isEmpty)


stripBullet : String -> String
stripBullet line =
    let
        trimmed =
            String.trimLeft line
    in
    if String.startsWith "- [ ] " trimmed || String.startsWith "- [x] " trimmed then
        String.dropLeft 6 trimmed

    else if String.startsWith "- " trimmed || String.startsWith "* " trimmed || String.startsWith "+ " trimmed then
        String.dropLeft 2 trimmed

    else
        trimmed


updateItem : Int -> (Item -> Item) -> Model -> Model
updateItem index change model =
    { model
        | items =
            List.indexedMap
                (\position item ->
                    if position == index then
                        change item

                    else
                        item
                )
                model.items
    }


{-| A Sub-project can only wait for another Sub-project; a choice that stopped being one is cleared.
-}
clearDanglingAfters : Model -> Model
clearDanglingAfters model =
    let
        subprojectIdeas =
            model.items
                |> List.indexedMap Tuple.pair
                |> List.filter (\( _, item ) -> isSubproject item)
                |> List.map (\( index, _ ) -> "idea:" ++ String.fromInt index)
                |> Set.fromList
    in
    { model
        | items =
            List.map
                (\item ->
                    if not (isSubproject item) || (String.startsWith "idea:" item.after && not (Set.member item.after subprojectIdeas)) then
                        { item | after = "" }

                    else
                        item
                )
                model.items
    }


isSubproject : Item -> Bool
isSubproject item =
    item.kind == "subproject" || item.kind == "someday"


updateGap : ProjectId -> (Gap -> Gap) -> Model -> Model
updateGap projectId change model =
    { model
        | gaps =
            List.map
                (\gap ->
                    if gap.projectId == projectId then
                        change gap

                    else
                        gap
                )
                model.gaps
    }



-- VIEW


view : Model -> Html Msg
view model =
    div [ class "dg-plan" ]
        [ h2 [] [ text ("Plan “" ++ projectTitle model ++ "”") ]
        , stepsView model.step
        , case model.step of
            PurposeStep ->
                textStep
                    { label = "Why does this Project exist?"
                    , hint = "Its purpose: what it is for, and how you'll judge it. A sentence or two is enough."
                    , value = model.purpose
                    , onChange = PurposeChanged
                    , back = Nothing
                    , next = GoTo OutcomeStep
                    }

            OutcomeStep ->
                textStep
                    { label = "What does done look like?"
                    , hint = "The desired outcome: picture it finished. This is the Project's Desired outcome."
                    , value = model.outcome
                    , onChange = OutcomeChanged
                    , back = Just PurposeStep
                    , next = GoTo IdeasStep
                    }

            IdeasStep ->
                textStep
                    { label = "What comes to mind?"
                    , hint = "Every idea, one per line, without judging or ordering it yet: steps, questions, risks, people, things to buy."
                    , value = model.ideas
                    , onChange = IdeasChanged
                    , back = Just OutcomeStep
                    , next = Organise
                    }

            OrganiseStep ->
                organiseView model

            NextActionsStep ->
                nextActionsView model
        , Ui.maybeView model.error (\message -> p [ class "dg-plan-error" ] [ text ("⚠ " ++ message) ])
        ]


projectTitle : Model -> String
projectTitle model =
    Data.findProject model.projectId model.snapshot.projects |> Maybe.map .title |> Maybe.withDefault "Project"


stepsView : Step -> Html Msg
stepsView current =
    ol [ class "dg-plan-steps" ]
        (List.map
            (\( step, name ) -> li [ classList [ ( "is-current", step == current ) ] ] [ text name ])
            [ ( PurposeStep, "Purpose" ), ( OutcomeStep, "Outcome" ), ( IdeasStep, "Ideas" ), ( OrganiseStep, "Organise" ), ( NextActionsStep, "Next Actions" ) ]
        )


textStep : { label : String, hint : String, value : String, onChange : String -> Msg, back : Maybe Step, next : Msg } -> Html Msg
textStep config =
    div [ class "dg-plan-step" ]
        [ p [ class "dg-plan-hint" ] [ text config.hint ]
        , Ui.labelled config.label
            (textarea [ class "dg-plan-text", rows 6, value config.value, onInput config.onChange, Ui.onModEnter config.next ] [])
        , navigation config.back (button [ class "mod-cta", onClick config.next ] [ text "Next" ])
        ]


navigation : Maybe Step -> Html Msg -> Html Msg
navigation back forward =
    div [ class "dg-plan-actions" ]
        [ case back of
            Just step ->
                button [ onClick (GoTo step) ] [ text "Back" ]

            Nothing ->
                button [ onClick Close ] [ text "Cancel" ]
        , forward
        ]


organiseView : Model -> Html Msg
organiseView model =
    let
        contextsId =
            "dg-plan-contexts"
    in
    div [ class "dg-plan-step" ]
        [ p [ class "dg-plan-hint" ]
            [ text "Decide what each idea becomes. More than one step makes it a Sub-project, which can wait for another; not now makes it Someday. Nothing is written until you create the plan." ]
        , datalist [ id contextsId ] (List.map (\context -> option [ value context ] []) (Data.contexts model.snapshot.actions))
        , if List.any (\item -> item.kind == "action") model.items then
            Ui.labelled "Context for new Next Actions"
                (input [ class "dg-plan-default-context", list contextsId, placeholder "Context for Next Actions…", value model.defaultContext, onInput DefaultContextChanged ] [])

          else
            text ""
        , if List.isEmpty model.items then
            p [ class "dg-plan-empty" ] [ text "No ideas yet. Go back to add some, or create the plan with just its purpose and outcome." ]

          else
            ul [ class "dg-plan-items" ] (List.indexedMap (itemView model contextsId) model.items)
        , navigation (Just IdeasStep)
            (button [ class "mod-cta", disabled (saving model), onClick Create ]
                [ text
                    (if saving model then
                        "Creating…"

                     else
                        "Create"
                    )
                ]
            )
        ]


saving : Model -> Bool
saving model =
    List.member Saving (Host.pending model.requests)


itemView : Model -> String -> Int -> Item -> Html Msg
itemView model contextsId index item =
    li [ classList [ ( "dg-plan-item", True ), ( "is-dropped", item.kind == "drop" ) ] ]
        [ Ui.labelled ("Idea " ++ String.fromInt (index + 1))
            (input [ class "dg-plan-item-title", value item.title, onInput (ItemTitleChanged index) ] [])
        , Ui.labelled ("What " ++ item.title ++ " becomes")
            (select [ class "dropdown", onInput (ItemKindChanged index) ]
                (List.map
                    (\( key, name ) -> option [ value key, selected (item.kind == key) ] [ text name ])
                    [ ( "action", "Next Action" ), ( "subproject", "Sub-project" ), ( "someday", "Someday" ), ( "drop", "Drop" ) ]
                )
            )
        , if item.kind == "action" then
            Ui.labelled ("Context of " ++ item.title)
                (input [ list contextsId, placeholder "Context…", value item.context, onInput (ItemContextChanged index) ] [])

          else if isSubproject item then
            Ui.labelled ("What " ++ item.title ++ " waits for")
                (select [ class "dropdown", onInput (ItemAfterChanged index) ]
                    (option [ value "", selected (item.after == "") ] [ text "Can start now" ]
                        :: (model.items
                                |> List.indexedMap Tuple.pair
                                |> List.filter (\( other, candidate ) -> other /= index && isSubproject candidate && not (String.isEmpty (String.trim candidate.title)))
                                |> List.map
                                    (\( other, candidate ) ->
                                        let
                                            key =
                                                "idea:" ++ String.fromInt other
                                        in
                                        option [ value key, selected (item.after == key) ] [ text ("After “" ++ candidate.title ++ "”") ]
                                    )
                           )
                        ++ List.map
                            (\project ->
                                let
                                    key =
                                        "project:" ++ project.id
                                in
                                option [ value key, selected (item.after == key) ] [ text ("After “" ++ project.title ++ "”") ]
                            )
                            (openSubprojects model)
                    )
                )

          else
            span [ class "dg-plan-hint" ] [ text "Kept in the Diary entry, not created." ]
        ]


{-| Sub-projects of the tree that are still open, which a new one may wait for.
-}
openSubprojects : Model -> List Project
openSubprojects model =
    let
        below parentId =
            model.snapshot.projects
                |> List.filter (\project -> project.parentProjectId == Just parentId)
                |> List.concatMap (\project -> project :: below project.id)
    in
    below model.projectId
        |> List.filter (\project -> ProjectStatus.isOpen project.status)


nextActionsView : Model -> Html Msg
nextActionsView model =
    div [ class "dg-plan-step" ]
        [ if List.isEmpty model.gaps then
            p [ class "dg-plan-done" ] [ strong [] [ text "✓ Every active branch has a Next Action." ], text " The plan is in the Project, and the Diary records it." ]

          else
            div []
                [ p [ class "dg-plan-hint" ]
                    [ text "These active branches have no Next Action yet. Add the very next step, or hand the branch to an agent." ]
                , datalist [ id "dg-plan-contexts" ] (List.map (\context -> option [ value context ] []) (Data.contexts model.snapshot.actions))
                , ul [ class "dg-plan-gaps" ] (List.map (gapView model) model.gaps)
                ]
        , div [ class "dg-plan-actions" ] [ button [ class "mod-cta", onClick Close ] [ text "Done" ] ]
        ]


gapView : Model -> Gap -> Html Msg
gapView model gap =
    li [ class "dg-plan-gap" ]
        [ strong [] [ text gap.title ]
        , div [ class "dg-plan-gap-add" ]
            [ Ui.labelled ("Next Action for " ++ gap.title)
                (input [ placeholder "Next Action…", value gap.draft, onInput (GapDraftChanged gap.projectId), Ui.onEnter { enter = AddGapAction gap.projectId, ignore = GapDraftChanged gap.projectId gap.draft } ] [])
            , Ui.labelled ("Context for " ++ gap.title)
                (input [ list "dg-plan-contexts", placeholder "Context…", value gap.context, onInput (GapContextChanged gap.projectId) ] [])
            , button [ disabled (List.member (Adding gap.projectId) (Host.pending model.requests)), onClick (AddGapAction gap.projectId) ] [ text "Add" ]
            , button [ onClick (Delegate gap.projectId) ] [ text "Delegate…" ]
            ]
        ]
